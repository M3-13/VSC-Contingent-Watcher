import * as vscode from 'vscode';
import { Config } from './config';
import { expectedSurplus } from './core/surplus';
import { newlyCrossedThreshold } from './core/thresholds';
import { Forecast, QuotaSnapshot } from './core/types';
import { fmt, fmtDate, surplusMessage, unitLabel } from './format';
import { State } from './state';

/** Shows at most one notification per refresh, never twice for the same event. */
export async function maybeNotify(snap: QuotaSnapshot, f: Forecast, cfg: Config, state: State): Promise<void> {
  if (!cfg.warningsEnabled || snap.unlimited || state.snoozed) {
    return;
  }

  const crossed = newlyCrossedThreshold(f.usedPercent, cfg.thresholds, state.notifiedThresholds(snap.resetDate));
  if (crossed !== undefined) {
    await state.markNotified(snap.resetDate, crossed, cfg.thresholds);
    const unit = unitLabel(snap);
    const msg =
      crossed >= 100
        ? vscode.l10n.t('Copilot allowance used up. Resets on {0}.', fmtDate(snap.resetDate))
        : vscode.l10n.t(
            'Copilot: {0}% of your allowance used — {1} {2} left, about {3} per day until {4}.',
            crossed,
            fmt(snap.remaining),
            unit,
            fmt(f.dailyBudget),
            fmtDate(snap.resetDate),
          );
    const show = crossed >= 90 ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    await handle(await show(msg, vscode.l10n.t('Saving tips'), vscode.l10n.t('Details'), vscode.l10n.t('Snooze 24h')), state);
    return;
  }

  if (cfg.paceWarning && f.status === 'critical' && f.exhaustionDate && !state.paceWarnedToday()) {
    await state.markPaceWarned();
    const msg = vscode.l10n.t(
      'Copilot: at your current pace the allowance runs out on {0} (reset {1}). Budget: {2} per day.',
      fmtDate(f.exhaustionDate),
      fmtDate(snap.resetDate),
      fmt(f.dailyBudget),
    );
    await handle(await vscode.window.showInformationMessage(msg, vscode.l10n.t('Saving tips'), vscode.l10n.t('Snooze 24h')), state);
    return;
  }

  const unused = cfg.surplusHint ? expectedSurplus(snap, f) : undefined;
  if (unused !== undefined && !state.surplusNotified(snap.resetDate)) {
    await state.markSurplusNotified(snap.resetDate);
    await handle(await vscode.window.showInformationMessage(surplusMessage(snap, unused), vscode.l10n.t('Details')), state);
  }
}

async function handle(choice: string | undefined, state: State): Promise<void> {
  if (choice === vscode.l10n.t('Saving tips')) {
    await vscode.commands.executeCommand('contingentWatcher.showTips');
  } else if (choice === vscode.l10n.t('Details')) {
    await vscode.commands.executeCommand('contingentWatcher.showDetails');
  } else if (choice === vscode.l10n.t('Snooze 24h')) {
    await state.snooze(24);
  }
}
