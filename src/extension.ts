import * as vscode from 'vscode';
import { Config, readConfig, SECTION } from './config';
import { DashboardCommand, DashboardModel, DashboardSettingKey } from './core/dashboardModel';
import { computeForecast } from './core/forecast';
import { computeMetrics } from './core/metrics';
import { summarizeCycle } from './core/cycles';
import { relevantTips, situationsFor } from './core/tips';
import { Forecast, QuotaSnapshot } from './core/types';
import { dashboardStrings } from './dashboardStrings';
import { DashboardViewProvider } from './dashboardView';
import { fmtDate, surplusMessage, statusLabel, unitLabel } from './format';
import { maybeNotify } from './notifier';
import { QuotaService } from './quotaService';
import { State } from './state';
import { StatusBar, ViewState } from './statusBar';
import { ProviderId } from './auth';
import { ActivityTracker } from './activityTracker';
import { guidedSignIn } from './signIn';
import { CopilotOptions } from './copilotOptions';
import { BillingService } from './billingService';
import { openBtwInput, registerBtwParticipant, showBtwPanel } from './chat/btwParticipant';
import { resolveColor } from './core/appearance';
import { expectedSurplus } from './core/surplus';

const BILLING_URL = 'https://github.com/settings/billing';
const COPILOT_SETTINGS_URL = 'https://github.com/settings/copilot';
const WALKTHROUGH = 'contingentWatcher.gettingStarted';

/** Maps dashboard setting keys to our configuration keys. */
const SETTING_KEYS: Partial<Record<DashboardSettingKey, string>> = {
  display: 'statusBar.display',
  countWeekends: 'budget.countWeekends',
  reserve: 'budget.reserve',
  thresholds: 'warnings.thresholds',
  warningsEnabled: 'warnings.enabled',
  paceWarning: 'warnings.paceWarning',
  tipsEnabled: 'tips.enabled',
  authProvider: 'auth.provider',
  accent: 'appearance.accentColor',
  statusBarIcon: 'statusBar.icon',
  statusBarColor: 'statusBar.color',
  surplusHint: 'warnings.surplusHint',
  activityTracking: 'activity.enabled',
  refreshIntervalMinutes: 'refreshIntervalMinutes',
  alignment: 'statusBar.alignment',
  apiUrl: 'auth.apiUrl',
  preferredModels: 'chat.preferredModels',
  btwIncludeChat: 'btw.includeChat',
  btwModel: 'btw.model',
  btwOpenIn: 'btw.openIn',
  unit: 'unit',
};


class Controller implements vscode.Disposable {
  private cfg: Config = readConfig();
  private readonly service: QuotaService;
  private readonly bar: StatusBar;
  readonly dashboard: DashboardViewProvider;
  private timer: NodeJS.Timeout | undefined;
  private view: ViewState = { kind: 'loading' };
  private provider: ProviderId | undefined;
  private inFlight: Promise<void> | undefined;
  readonly activity: ActivityTracker;
  readonly billing: BillingService;
  readonly copilot = new CopilotOptions();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: State,
    log: vscode.LogOutputChannel,
  ) {
    this.service = new QuotaService(log);
    this.activity = new ActivityTracker(context.globalState, this.cfg.activityTracking);
    this.billing = new BillingService(context.secrets, log);
    // Re-render the dashboard when background data changes.
    this.activity.onDidChange(() => this.dashboard?.visible && this.dashboard.update(this.model()));
    this.billing.onDidChange(() => this.dashboard?.update(this.model()));
    this.bar = new StatusBar(this.cfg);
    this.dashboard = new DashboardViewProvider(context.extensionUri, {
      getModel: () => this.model(),
      onCommand: (c) => this.onDashboardCommand(c),
      onSetting: (k, v) => this.onDashboardSetting(k, v),
    });
    const last = state.last;
    if (last) {
      // Show cached value immediately, so the status bar never looks empty on startup.
      this.view = { kind: 'ok', snap: last, forecast: this.forecast(last) };
    }
    this.render();
  }

  private get forecastOpts() {
    return { countWeekends: this.cfg.countWeekends, reserve: this.cfg.reserve };
  }

  private forecast(snap: QuotaSnapshot): Forecast {
    return computeForecast(snap, this.state.history, this.forecastOpts);
  }

  /** Pushes the current state to the status bar and the dashboard. */
  render(): void {
    this.bar.render(this.view, this.cfg);
    this.dashboard.update(this.model());
  }

  start(): void {
    void this.refresh();
    this.schedule();
  }

  schedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      // Don't poll while the window is in the background; refresh on focus instead.
      if (vscode.window.state.focused) {
        void this.refresh();
      }
    }, this.cfg.refreshIntervalMinutes * 60_000);
  }

  onConfigChanged(): void {
    this.cfg = readConfig();
    this.activity.setEnabled(this.cfg.activityTracking);
    this.schedule();
    if (this.view.kind === 'ok') {
      this.view = { ...this.view, forecast: this.forecast(this.view.snap) };
    }
    this.render();
  }

  onFocus(): void {
    const last = this.state.last;
    // Refresh on focus if data is older than 2 minutes.
    if (!last || Date.now() - last.fetchedAt > 120_000) {
      void this.refresh();
    }
  }

  refresh(interactive = false): Promise<void> {
    this.inFlight ??= this.doRefresh(interactive).finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async doRefresh(interactive: boolean): Promise<void> {
    const res = await this.service.fetch(interactive);
    this.provider = res.target.provider;
    switch (res.kind) {
      case 'ok': {
        const prev = this.state.last;
        await this.state.record(res.snapshot);
        if (prev && prev.resetDate === res.snapshot.resetDate && res.snapshot.used > prev.used) {
          await this.activity.recordUsage(res.snapshot.used - prev.used);
        }
        void this.billing.refresh();
        const forecast = this.forecast(res.snapshot);
        this.view = { kind: 'ok', snap: res.snapshot, forecast };
        this.render();
        await maybeNotify(res.snapshot, forecast, this.cfg, this.state);
        return;
      }
      case 'error': {
        const last = this.state.last;
        this.view = { kind: 'error', message: res.message, stale: last ? { snap: last, forecast: this.forecast(last) } : undefined };
        break;
      }
      case 'signedOut':
        this.view = { kind: 'signedOut', provider: res.target.provider };
        break;
      case 'noCopilot':
        this.view = { kind: 'noCopilot', provider: res.target.provider, status: res.status };
        break;
    }
    this.render();
  }

  /** Guided sign-in (account type, enterprise address), then interactive refresh. */
  async signIn(): Promise<void> {
    if (!(await guidedSignIn())) {
      return;
    }
    this.cfg = readConfig();
    await this.refresh(true);
    if (this.view.kind === 'signedOut' || this.view.kind === 'error' || this.view.kind === 'noCopilot') {
      const log = vscode.l10n.t('Show log');
      const retry = vscode.l10n.t('Try again');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Sign-in did not work. The log shows which address was tried and what GitHub answered.'),
        log,
        retry,
      );
      if (choice === log) {
        await vscode.commands.executeCommand('contingentWatcher.showLog');
      } else if (choice === retry) {
        await this.signIn();
      }
    }
  }

  /** Builds the dashboard model from the current view state. */
  model(): DashboardModel {
    const v = this.view;
    const data = v.kind === 'ok' ? v : v.kind === 'error' ? v.stale : undefined;
    const copilot = this.copilot;
    const installed = copilot.installed;
    const own = vscode.workspace.getConfiguration(SECTION);

    const model: DashboardModel = {
      state: data ? 'ok' : v.kind,
      stale: v.kind === 'error' && !!v.stale,
      errorMessage: v.kind === 'error' ? v.message : undefined,
      provider: this.provider,
      locale: vscode.env.language,
      strings: dashboardStrings(),
      appearance: { accentColor: resolveColor(this.cfg.accent) },
      models: this.modelsSection(data?.snap),
      review: this.reviewSection(data?.snap),
      activity: this.activitySection(),
      tips: data
        ? relevantTips(
            situationsFor({
              status: data.forecast.status,
              cycleElapsed: data.forecast.cycleElapsed,
              surplus: expectedSurplus(data.snap, data.forecast) !== undefined,
            }),
            new Date().getDate(),
          ).map((t) => ({ id: t.id, text: vscode.l10n.t(t.text), relevant: true }))
        : [],
      settings: {
        display: this.cfg.display,
        countWeekends: this.cfg.countWeekends,
        reserve: this.cfg.reserve,
        thresholds: this.cfg.thresholds,
        warningsEnabled: this.cfg.warningsEnabled,
        paceWarning: this.cfg.paceWarning,
        tipsEnabled: this.cfg.tipsEnabled,
        authProvider: vscode.workspace.getConfiguration(SECTION).get('auth.provider', 'auto'),
        snoozedUntil: this.state.snoozedUntil,
        copilotCompletions: installed ? copilot.completionsEnabled : undefined,
        copilotNextEdit: installed ? copilot.nextEditEnabled : undefined,
        copilotEagerness: installed ? copilot.eagerness : undefined,
        copilotLanguage: installed ? copilot.language : undefined,
        copilotSnoozeAvailable: installed && copilot.snoozeAvailable,
        refreshIntervalMinutes: this.cfg.refreshIntervalMinutes,
        alignment: this.cfg.alignment,
        apiUrl: own.get<string>('auth.apiUrl', ''),
        preferredModels: own.get<string[]>('chat.preferredModels', ['gpt-5-mini', 'gpt-4.1', 'gpt-4o']),
        btwIncludeChat: own.get<boolean>('btw.includeChat', true),
        btwModel: own.get<string>('btw.model', 'chat') === 'included' ? 'included' : 'chat',
        btwOpenIn: own.get<string>('btw.openIn', 'side') === 'window' ? 'window' : 'side',
        unit: (['credits', 'requests'] as const).find((u) => u === own.get<string>('unit')) ?? 'auto',
        accent: this.cfg.accent,
        statusBarIcon: this.cfg.statusBarIcon,
        statusBarColor: this.cfg.statusBarColor,
        surplusHint: this.cfg.surplusHint,
        activityTracking: this.cfg.activityTracking,
        billingTokenSet: this.billing.tokenSet,
      },
    };

    if (data) {
      const { snap, forecast: f } = data;
      const m = computeMetrics(snap, this.state.history, this.forecastOpts);
      model.quota = {
        unitLabel: unitLabel(snap),
        entitlement: snap.entitlement,
        used: snap.used,
        remaining: snap.remaining,
        usedPercent: f.usedPercent,
        unlimited: snap.unlimited,
        overagePermitted: snap.overagePermitted,
        overageCount: snap.overageCount,
        resetDate: snap.resetDate,
        plan: snap.plan,
        fetchedAt: snap.fetchedAt,
      };
      model.forecast = {
        status: f.status,
        statusLabel: statusLabel(f),
        cycleElapsed: f.cycleElapsed,
        paceRatio: Number.isFinite(f.paceRatio) ? f.paceRatio : 99,
        daysLeft: f.daysLeft,
        dailyBudget: f.dailyBudget,
        burnRate: f.burnRate,
        projectedUsed: f.projectedUsed,
        exhaustionDate: f.exhaustionDate?.toISOString(),
      };
      model.metrics = m;
      const unused = this.cfg.surplusHint ? expectedSurplus(snap, f) : undefined;
      if (unused !== undefined) {
        model.surplus = { expectedUnused: unused, message: surplusMessage(snap, unused) };
      }
    }
    return model;
  }

  private monthLabel(d: Date): string {
    return d.toLocaleDateString(vscode.env.language, { month: 'long', year: 'numeric' });
  }

  private modelsSection(snap: QuotaSnapshot | undefined): DashboardModel['models'] {
    const b = this.billing.state;
    // Company seats are billed to the organization; the personal billing
    // report then has no per-model data (only org admins can see it).
    if (snap?.plan && /business|enterprise/i.test(snap.plan) && b.state !== 'ok') {
      return {
        state: 'error',
        errorMessage: vscode.l10n.t(
          'Your Copilot seat is billed to your organization, so GitHub most likely shows per-model usage only to its admins.',
        ),
        items: [],
      };
    }
    switch (b.state) {
      case 'ok':
        return {
          state: 'ok',
          items: b.items,
          periodLabel: this.monthLabel(b.period),
          showCredits: b.items.length > 0 && b.items.every((i) => i.credits !== undefined),
        };
      case 'error':
        return { state: 'error', errorMessage: b.message, items: [] };
      default:
        return { state: b.state, items: [] };
    }
  }

  private reviewSection(current: QuotaSnapshot | undefined): DashboardModel['review'] {
    // A cycle is labelled by the month it covered (the month before its reset).
    const label = (resetDate: string) => {
      const r = new Date(resetDate);
      return this.monthLabel(new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() - 1, Math.max(1, r.getUTCDate()))));
    };
    const cycles: DashboardModel['review']['cycles'] = [];
    if (current) {
      const s = summarizeCycle(current, this.state.history, this.forecastOpts, Date.now());
      cycles.push({ ...s, label: label(s.resetDate), current: true });
    }
    for (const c of this.state.cycles) {
      if (!current || c.resetDate.slice(0, 10) !== current.resetDate.slice(0, 10)) {
        cycles.push({ ...c, label: label(c.resetDate), current: false });
      }
    }
    return { cycles: cycles.slice(0, 6) };
  }

  private activitySection(): DashboardModel['activity'] {
    const { items, isActive } = this.activity.snapshot();
    return {
      enabled: this.cfg.activityTracking,
      items: items.slice(0, 50).map((i) => ({
        id: i.id,
        title: i.day ? `${i.branch ?? i.repo} · ${fmtDate(new Date(i.start))}` : (i.branch ?? i.repo),
        detail: i.detail,
        repo: i.repo,
        start: i.start,
        end: i.end,
        activeMinutes: Math.round(i.activeMs / 60_000),
        used: Math.round(i.used * 10) / 10,
        active: isActive(i),
      })),
    };
  }

  private githubUrl(url: string): string {
    // Point enterprise users to their own host.
    const host = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
    if (this.provider === 'github-enterprise' && host) {
      return url.replace('https://github.com', host.replace(/\/+$/, ''));
    }
    return url;
  }

  async onDashboardCommand(c: DashboardCommand): Promise<unknown> {
    switch (c) {
      case 'refresh':
        return this.refresh();
      case 'signIn':
        return this.signIn();
      case 'showLog':
        return vscode.commands.executeCommand('contingentWatcher.showLog');
      case 'openSettings':
        return vscode.commands.executeCommand('contingentWatcher.openSettings');
      case 'openBilling':
        return vscode.env.openExternal(vscode.Uri.parse(this.githubUrl(BILLING_URL)));
      case 'manageCopilot':
        return vscode.env.openExternal(vscode.Uri.parse(this.githubUrl(COPILOT_SETTINGS_URL)));
      case 'openChat':
        return vscode.commands.executeCommand('workbench.action.chat.open');
      case 'snooze':
        await this.state.snooze(24);
        return this.render();
      case 'unsnooze':
        await this.state.unsnooze();
        return this.render();
      case 'configureBillingToken':
        return this.billing.configure();
      case 'clearBillingToken':
        return this.billing.clear();
      case 'clearActivity': {
        const yes = vscode.l10n.t('Clear');
        const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Clear the recorded activity history?'), { modal: true }, yes);
        return ok === yes ? this.activity.clear() : undefined;
      }
      case 'snoozeCompletions':
        return this.copilot.snooze();
      case 'btw':
        return vscode.commands.executeCommand('contingentWatcher.btw');
      case 'openWalkthrough':
        return vscode.commands.executeCommand('workbench.action.openWalkthrough', `${this.context.extension.id}#${WALKTHROUGH}`, false);
    }
  }

  async onDashboardSetting(key: DashboardSettingKey, value: unknown): Promise<void> {
    const target = vscode.ConfigurationTarget.Global;
    switch (key) {
      case 'copilotCompletions':
        return this.copilot.setCompletions(value === true);
      case 'copilotNextEdit':
        return this.copilot.setNextEdit(value === true);
      case 'copilotLanguage':
        return this.copilot.setLanguage(value === true);
      case 'copilotEagerness':
        return this.copilot.setEagerness(value);
    }
    const cfgKey = SETTING_KEYS[key];
    if (!cfgKey) {
      return;
    }
    let v = value;
    if (key === 'reserve') {
      v = Math.max(0, Number(value) || 0);
    } else if (key === 'refreshIntervalMinutes') {
      v = Math.min(120, Math.max(2, Number(value) || 10));
    } else if (key === 'alignment') {
      v = value === 'left' ? 'left' : 'right';
    } else if (key === 'apiUrl') {
      v = typeof value === 'string' ? value.trim() : '';
    } else if (key === 'unit') {
      v = value === 'credits' || value === 'requests' ? value : 'auto';
    } else if (key === 'btwOpenIn') {
      v = value === 'window' ? 'window' : 'side';
    } else if (key === 'btwModel') {
      v = value === 'included' ? 'included' : 'chat';
    } else if (key === 'preferredModels') {
      v = Array.isArray(value) ? [...new Set(value.map((x) => String(x).trim()).filter(Boolean))] : undefined;
    } else if (key === 'thresholds') {
      v = Array.isArray(value)
        ? [...new Set(value.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 100))].sort((a, b) => a - b)
        : undefined;
    }
    // Configuration change event re-renders.
    await vscode.workspace.getConfiguration(SECTION).update(cfgKey, v, target);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.bar.dispose();
    this.activity.dispose();
    this.billing.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const state = new State(context.globalState);
  const log = vscode.window.createOutputChannel('Copilot Contingent', { log: true });
  const ctl = new Controller(context, state, log);
  const openDashboard = () => vscode.commands.executeCommand(`${DashboardViewProvider.viewId}.focus`);

  context.subscriptions.push(
    ctl,
    log,
    vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewId, ctl.dashboard),
    vscode.commands.registerCommand('contingentWatcher.btw', () => openBtwInput()),
    vscode.commands.registerCommand('contingentWatcher.btw.show', () => showBtwPanel()),
    registerBtwParticipant(context, log),
    vscode.commands.registerCommand('contingentWatcher.configureBillingToken', () => ctl.onDashboardCommand('configureBillingToken')),
    vscode.commands.registerCommand('contingentWatcher.showLog', () => log.show()),
    vscode.commands.registerCommand('contingentWatcher.refresh', () => ctl.refresh()),
    vscode.commands.registerCommand('contingentWatcher.signIn', () => ctl.signIn()),
    vscode.commands.registerCommand('contingentWatcher.showDetails', openDashboard),
    vscode.commands.registerCommand('contingentWatcher.showTips', openDashboard),
    vscode.commands.registerCommand('contingentWatcher.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    ),
    vscode.commands.registerCommand('contingentWatcher.snooze', async () => {
      await ctl.onDashboardCommand('snooze');
      vscode.window.setStatusBarMessage(vscode.l10n.t('Copilot quota warnings snoozed for 24h'), 3000);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        ctl.onConfigChanged();
      } else if (e.affectsConfiguration('github.copilot') || e.affectsConfiguration('github-enterprise') || e.affectsConfiguration('editor.inlineSuggest')) {
        ctl.render();
      }
    }),
    vscode.window.onDidChangeWindowState((s) => s.focused && ctl.onFocus()),
    // The language toggle follows the active editor.
    vscode.window.onDidChangeActiveTextEditor(() => ctl.dashboard.visible && ctl.render()),
    vscode.extensions.onDidChange(() => {
      ctl.copilot.discover();
      ctl.render();
    }),
    vscode.authentication.onDidChangeSessions((e) => e.provider.id.startsWith('github') && void ctl.refresh()),
  );
  ctl.start();
}

export function deactivate(): void {
  // Disposables are cleaned up via context.subscriptions.
}
