import * as vscode from 'vscode';
import { Config, readConfig, SECTION } from './config';
import { DashboardCommand, DashboardModel, DashboardSettingKey } from './core/dashboardModel';
import { computeForecast } from './core/forecast';
import { computeMetrics } from './core/metrics';
import { TIPS } from './core/tips';
import { Forecast, QuotaSnapshot } from './core/types';
import { dashboardStrings } from './dashboardStrings';
import { DashboardViewProvider } from './dashboardView';
import { statusLabel, unitLabel } from './format';
import { maybeNotify } from './notifier';
import { QuotaService } from './quotaService';
import { State } from './state';
import { StatusBar, ViewState } from './statusBar';
import { ProviderId } from './auth';

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
};

function copilotInstalled(): boolean {
  return !!(vscode.extensions.getExtension('GitHub.copilot') ?? vscode.extensions.getExtension('GitHub.copilot-chat'));
}

class Controller implements vscode.Disposable {
  private cfg: Config = readConfig();
  private readonly service: QuotaService;
  private readonly bar: StatusBar;
  readonly dashboard: DashboardViewProvider;
  private timer: NodeJS.Timeout | undefined;
  private view: ViewState = { kind: 'loading' };
  private provider: ProviderId | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: State,
    log: vscode.LogOutputChannel,
  ) {
    this.service = new QuotaService(log);
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
        await this.state.record(res.snapshot);
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

  /** Builds the dashboard model from the current view state. */
  model(): DashboardModel {
    const v = this.view;
    const data = v.kind === 'ok' ? v : v.kind === 'error' ? v.stale : undefined;
    const copilot = vscode.workspace.getConfiguration('github.copilot');
    const installed = copilotInstalled();
    const status = data?.forecast.status;

    const model: DashboardModel = {
      state: data ? 'ok' : v.kind,
      stale: v.kind === 'error' && !!v.stale,
      errorMessage: v.kind === 'error' ? v.message : undefined,
      provider: this.provider,
      locale: vscode.env.language,
      strings: dashboardStrings(),
      tips: TIPS.map((t) => ({ id: t.id, text: vscode.l10n.t(t.text), relevant: !!status && t.when.includes(status) })).sort(
        (a, b) => Number(b.relevant) - Number(a.relevant),
      ),
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
        copilotCompletions: installed ? copilot.get<Record<string, boolean>>('enable')?.['*'] !== false : undefined,
        copilotNextEdit: installed ? copilot.get<boolean>('nextEditSuggestions.enabled', false) : undefined,
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
    }
    return model;
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
        return this.refresh(true);
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
      case 'openWalkthrough':
        return vscode.commands.executeCommand('workbench.action.openWalkthrough', `${this.context.extension.id}#${WALKTHROUGH}`, false);
    }
  }

  async onDashboardSetting(key: DashboardSettingKey, value: unknown): Promise<void> {
    const target = vscode.ConfigurationTarget.Global;
    if (key === 'copilotCompletions') {
      const copilot = vscode.workspace.getConfiguration('github.copilot');
      const current = copilot.get<Record<string, boolean>>('enable') ?? {};
      await copilot.update('enable', { ...current, '*': value === true }, target);
      return;
    }
    if (key === 'copilotNextEdit') {
      await vscode.workspace.getConfiguration('github.copilot').update('nextEditSuggestions.enabled', value === true, target);
      return;
    }
    const cfgKey = SETTING_KEYS[key];
    if (!cfgKey) {
      return;
    }
    let v = value;
    if (key === 'reserve') {
      v = Math.max(0, Number(value) || 0);
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
    vscode.commands.registerCommand('contingentWatcher.showLog', () => log.show()),
    vscode.commands.registerCommand('contingentWatcher.refresh', () => ctl.refresh()),
    vscode.commands.registerCommand('contingentWatcher.signIn', () => ctl.refresh(true)),
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
      } else if (e.affectsConfiguration('github.copilot') || e.affectsConfiguration('github-enterprise')) {
        ctl.render();
      }
    }),
    vscode.window.onDidChangeWindowState((s) => s.focused && ctl.onFocus()),
    vscode.authentication.onDidChangeSessions((e) => e.provider.id.startsWith('github') && void ctl.refresh()),
  );
  ctl.start();
}

export function deactivate(): void {
  // Disposables are cleaned up via context.subscriptions.
}
