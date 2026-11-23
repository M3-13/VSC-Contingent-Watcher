import * as vscode from 'vscode';
import { Config, readConfig, SECTION } from './config';
import { computeForecast } from './core/forecast';
import { TIPS } from './core/tips';
import { Forecast, QuotaSnapshot } from './core/types';
import { bar, fmt, fmtDate, statusLabel, unitLabel } from './format';
import { maybeNotify } from './notifier';
import { QuotaService } from './quotaService';
import { State } from './state';
import { StatusBar, ViewState } from './statusBar';

const BILLING_URL = 'https://github.com/settings/billing';

class Controller implements vscode.Disposable {
  private cfg: Config = readConfig();
  private readonly service: QuotaService;
  private readonly bar: StatusBar;
  private timer: NodeJS.Timeout | undefined;
  private view: ViewState = { kind: 'loading' };
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly state: State,
    log: vscode.LogOutputChannel,
  ) {
    this.service = new QuotaService(log);
    this.bar = new StatusBar(this.cfg);
    const last = state.last;
    if (last) {
      // Show cached value immediately, so the status bar never looks empty on startup.
      this.view = { kind: 'ok', snap: last, forecast: this.forecast(last) };
    }
    this.bar.render(this.view, this.cfg);
  }

  private forecast(snap: QuotaSnapshot): Forecast {
    return computeForecast(snap, this.state.history, { countWeekends: this.cfg.countWeekends, reserve: this.cfg.reserve });
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
    this.bar.render(this.view, this.cfg);
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
    switch (res.kind) {
      case 'ok': {
        await this.state.record(res.snapshot);
        const forecast = this.forecast(res.snapshot);
        this.view = { kind: 'ok', snap: res.snapshot, forecast };
        this.bar.render(this.view, this.cfg);
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
    this.bar.render(this.view, this.cfg);
  }

  async showDetails(): Promise<void> {
    const v = this.view.kind === 'ok' ? this.view : this.view.kind === 'error' ? this.view.stale : undefined;
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const items: Item[] = [];
    if (v) {
      const { snap, forecast: f } = v;
      const unit = unitLabel(snap);
      items.push(
        { label: `$(pulse) ${statusLabel(f)}`, description: `${Math.round(f.usedPercent)}% ${vscode.l10n.t('used')}`, detail: bar(f.usedPercent / 100, 30) },
        {
          label: `$(dashboard) ${vscode.l10n.t('Remaining')}: ${fmt(snap.remaining)} / ${fmt(snap.entitlement)} ${unit}`,
          description: vscode.l10n.t('Resets on {0}', fmtDate(snap.resetDate)),
        },
        {
          label: `$(calendar) ${vscode.l10n.t('Daily budget')}: ${fmt(f.dailyBudget)} ${unit}`,
          description: vscode.l10n.t('{0} budget days left', fmt(f.daysLeft)),
        },
        {
          label: `$(graph-line) ${vscode.l10n.t('Your pace')}: ${fmt(f.burnRate)} ${unit}/${vscode.l10n.t('day')}`,
          description: f.exhaustionDate
            ? vscode.l10n.t('At this pace empty on {0}', fmtDate(f.exhaustionDate))
            : vscode.l10n.t('Projected at reset: {0}', fmt(f.projectedUsed)),
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
      );
    } else if (this.view.kind === 'signedOut') {
      items.push({ label: `$(account) ${vscode.l10n.t('Sign in with GitHub')}`, run: () => this.refresh(true) });
    }
    if (this.view.kind !== 'ok') {
      items.push({ label: `$(output) ${vscode.l10n.t('Show log')}`, run: () => vscode.commands.executeCommand('contingentWatcher.showLog') });
    }
    items.push(
      { label: `$(refresh) ${vscode.l10n.t('Refresh')}`, run: () => this.refresh() },
      { label: `$(lightbulb) ${vscode.l10n.t('Saving tips')}`, run: () => vscode.commands.executeCommand('contingentWatcher.showTips') },
      { label: `$(link-external) ${vscode.l10n.t('Open GitHub billing')}`, run: () => vscode.env.openExternal(vscode.Uri.parse(BILLING_URL)) },
      { label: `$(gear) ${vscode.l10n.t('Settings')}`, run: () => vscode.commands.executeCommand('contingentWatcher.openSettings') },
    );
    const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Copilot Contingent'), matchOnDescription: true });
    await pick?.run?.();
  }

  async showTips(): Promise<void> {
    const status = this.view.kind === 'ok' ? this.view.forecast.status : undefined;
    const sorted = [...TIPS].sort((a, b) => Number(status ? b.when.includes(status) : 0) - Number(status ? a.when.includes(status) : 0));
    await vscode.window.showQuickPick(
      sorted.map((t) => ({
        label: `$(lightbulb) ${vscode.l10n.t(t.text)}`,
        description: status && t.when.includes(status) ? vscode.l10n.t('relevant now') : undefined,
      })),
      { title: vscode.l10n.t('How to make your Copilot allowance last'), matchOnDescription: true },
    );
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
  const ctl = new Controller(state, log);
  context.subscriptions.push(
    ctl,
    log,
    vscode.commands.registerCommand('contingentWatcher.showLog', () => log.show()),
    vscode.commands.registerCommand('contingentWatcher.refresh', () => ctl.refresh()),
    vscode.commands.registerCommand('contingentWatcher.signIn', () => ctl.refresh(true)),
    vscode.commands.registerCommand('contingentWatcher.showDetails', () => ctl.showDetails()),
    vscode.commands.registerCommand('contingentWatcher.showTips', () => ctl.showTips()),
    vscode.commands.registerCommand('contingentWatcher.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    ),
    vscode.commands.registerCommand('contingentWatcher.snooze', async () => {
      await state.snooze(24);
      vscode.window.setStatusBarMessage(vscode.l10n.t('Copilot quota warnings snoozed for 24h'), 3000);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(SECTION) && ctl.onConfigChanged()),
    vscode.window.onDidChangeWindowState((s) => s.focused && ctl.onFocus()),
    vscode.authentication.onDidChangeSessions((e) => e.provider.id.startsWith('github') && void ctl.refresh()),
  );
  ctl.start();
}

export function deactivate(): void {
  // Disposables are cleaned up via context.subscriptions.
}
