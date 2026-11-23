import * as vscode from 'vscode';
import { ProviderId } from './auth';
import { Config } from './config';
import { pickTip } from './core/tips';
import { Forecast, QuotaSnapshot } from './core/types';
import { bar, fmt, fmtDate, statusLabel, unitLabel } from './format';

export type ViewState =
  | { kind: 'loading' }
  | { kind: 'signedOut'; provider: ProviderId }
  | { kind: 'noCopilot'; provider: ProviderId; status?: number }
  | { kind: 'error'; message: string; stale?: { snap: QuotaSnapshot; forecast: Forecast } }
  | { kind: 'ok'; snap: QuotaSnapshot; forecast: Forecast };

const ICON = '$(copilot)';

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private alignment: Config['alignment'];

  constructor(cfg: Config) {
    this.alignment = cfg.alignment;
    this.item = this.create();
  }

  private create(): vscode.StatusBarItem {
    const align = this.alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
    // Priority slightly above Copilot's own item so we sit right next to it.
    const item = vscode.window.createStatusBarItem('contingentWatcher.status', align, 101);
    item.name = vscode.l10n.t('Copilot Contingent');
    item.command = 'contingentWatcher.showDetails';
    item.show();
    return item;
  }

  render(state: ViewState, cfg: Config): void {
    if (cfg.alignment !== this.alignment) {
      this.item.dispose();
      this.alignment = cfg.alignment;
      this.item = this.create();
    }
    const item = this.item;
    item.backgroundColor = undefined;
    item.command = 'contingentWatcher.showDetails';

    switch (state.kind) {
      case 'loading':
        item.text = `${ICON} $(sync~spin)`;
        item.tooltip = vscode.l10n.t('Loading Copilot quota…');
        return;
      case 'signedOut':
        item.text = `${ICON} $(account)`;
        item.tooltip = this.hint(
          state.provider === 'github-enterprise'
            ? vscode.l10n.t('Sign in with GitHub Enterprise to see your Copilot quota')
            : vscode.l10n.t('Sign in with GitHub to see your Copilot quota'),
          vscode.l10n.t('Enterprise account? Set the provider in the settings or check the log.'),
        );
        item.command = 'contingentWatcher.signIn';
        return;
      case 'noCopilot':
        item.text = `${ICON} —`;
        item.tooltip = this.hint(
          vscode.l10n.t('No metered Copilot quota found for this account'),
          state.status === 403
            ? vscode.l10n.t('Access denied (403). Your organization may require SSO authorization or block this endpoint.')
            : vscode.l10n.t('Enterprise account? Set the provider in the settings or check the log.'),
        );
        return;
      case 'error':
        if (state.stale) {
          this.renderOk(state.stale.snap, state.stale.forecast, cfg, true);
        } else {
          item.text = `${ICON} $(warning)`;
          item.tooltip = vscode.l10n.t('Could not load Copilot quota: {0}', state.message);
        }
        return;
      case 'ok':
        this.renderOk(state.snap, state.forecast, cfg, false);
    }
  }

  private renderOk(snap: QuotaSnapshot, f: Forecast, cfg: Config, stale: boolean): void {
    const item = this.item;
    if (snap.unlimited) {
      item.text = `${ICON} ∞`;
      item.tooltip = vscode.l10n.t('Unlimited Copilot quota');
      return;
    }
    let value: string;
    switch (cfg.display) {
      case 'used':
        value = `${fmt(snap.used)}/${fmt(snap.entitlement)}`;
        break;
      case 'percent':
        value = `${Math.round(f.usedPercent)}%`;
        break;
      case 'dailyBudget':
        value = vscode.l10n.t('{0}/day', fmt(f.dailyBudget));
        break;
      default:
        value = fmt(snap.remaining);
    }
    item.text = `${ICON} ${value}${stale ? ' $(history)' : ''}`;

    if (f.status === 'critical' || f.status === 'exhausted') {
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (f.status === 'ahead') {
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    item.tooltip = this.tooltip(snap, f, cfg, stale);
  }

  private hint(title: string, detail: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['contingentWatcher.signIn', 'contingentWatcher.showLog', 'contingentWatcher.openSettings'] };
    md.appendMarkdown(`**${title}**\n\n${detail}\n\n`);
    md.appendMarkdown(
      `[$(account) ${vscode.l10n.t('Sign in')}](command:contingentWatcher.signIn) · ` +
        `[$(output) ${vscode.l10n.t('Show log')}](command:contingentWatcher.showLog) · ` +
        `[$(gear) ${vscode.l10n.t('Settings')}](command:contingentWatcher.openSettings)`,
    );
    return md;
  }

  private tooltip(snap: QuotaSnapshot, f: Forecast, cfg: Config, stale: boolean): vscode.MarkdownString {
    const unit = unitLabel(snap);
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['contingentWatcher.refresh', 'contingentWatcher.showTips', 'contingentWatcher.openSettings'] };
    md.supportThemeIcons = true;

    md.appendMarkdown(`**${vscode.l10n.t('Copilot Contingent')}** — ${statusLabel(f)}\n\n`);
    md.appendMarkdown(
      `\`${bar(snap.used / Math.max(snap.entitlement, 1))}\` ${Math.round(f.usedPercent)}% ${vscode.l10n.t('used')}\n\n`,
    );
    md.appendMarkdown(
      `\`${bar(f.cycleElapsed)}\` ${Math.round(f.cycleElapsed * 100)}% ${vscode.l10n.t('of the month elapsed')}\n\n`,
    );
    md.appendMarkdown('---\n\n');
    md.appendMarkdown(`${vscode.l10n.t('Remaining')}: **${fmt(snap.remaining)}** / ${fmt(snap.entitlement)} ${unit}\n\n`);
    md.appendMarkdown(
      `${vscode.l10n.t('Daily budget')}: **${fmt(f.dailyBudget)}** ${unit} · ${vscode.l10n.t('your pace')}: ${fmt(f.burnRate)}/${vscode.l10n.t('day')}\n\n`,
    );
    if (f.exhaustionDate) {
      md.appendMarkdown(`$(warning) ${vscode.l10n.t('At this pace empty on {0}', fmtDate(f.exhaustionDate))}\n\n`);
    }
    md.appendMarkdown(`${vscode.l10n.t('Resets on {0}', fmtDate(snap.resetDate))}`);
    if (cfg.reserve > 0) {
      md.appendMarkdown(` · ${vscode.l10n.t('Reserve: {0}', fmt(cfg.reserve))}`);
    }
    md.appendMarkdown('\n\n');
    if (snap.overageCount > 0) {
      md.appendMarkdown(`$(credit-card) ${vscode.l10n.t('Overage this month: {0}', fmt(snap.overageCount))}\n\n`);
    }
    if (stale) {
      md.appendMarkdown(`$(history) ${vscode.l10n.t('Offline — showing data from {0}', new Date(snap.fetchedAt).toLocaleTimeString())}\n\n`);
    }
    if (cfg.tipsEnabled) {
      const tip = pickTip(f.status, new Date().getDate());
      md.appendMarkdown(`---\n\n$(lightbulb) ${vscode.l10n.t(tip.text)}\n\n`);
    }
    md.appendMarkdown(
      `[$(refresh)](command:contingentWatcher.refresh "${vscode.l10n.t('Refresh')}") ` +
        `[$(lightbulb)](command:contingentWatcher.showTips "${vscode.l10n.t('Tips')}") ` +
        `[$(gear)](command:contingentWatcher.openSettings "${vscode.l10n.t('Settings')}")`,
    );
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
