import * as vscode from 'vscode';
import { Forecast, QuotaSnapshot } from './core/types';

export function fmt(n: number): string {
  if (!Number.isFinite(n)) {
    return '∞';
  }
  const digits = n >= 100 || Number.isInteger(n) ? 0 : 1;
  const v = digits === 0 ? Math.round(n) : n;
  // Format with the VS Code display language and the same options as the
  // dashboard (otherwise e.g. "1,300" in a German status bar but "1.300" in
  // the dashboard). No trailing ".0" (e.g. 47.99999 → "48").
  const o = { minimumFractionDigits: 0, maximumFractionDigits: digits };
  try {
    return v.toLocaleString(vscode.env.language, o);
  } catch {
    return v.toLocaleString(undefined, o);
  }
}

export function unitLabel(snap: QuotaSnapshot): string {
  return snap.unit === 'credits' ? vscode.l10n.t('credits') : vscode.l10n.t('requests');
}

export function fmtDate(d: Date | string): string {
  return new Date(d).toLocaleDateString(vscode.env.language, { day: 'numeric', month: 'short' });
}

/** Text-based progress bar, renders fine in hovers and quick picks. */
export function bar(fraction: number, width = 20): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function statusLabel(f: Forecast): string {
  switch (f.status) {
    case 'onTrack':
      return vscode.l10n.t('On track');
    case 'ahead':
      return vscode.l10n.t('Faster than planned');
    case 'critical':
      return vscode.l10n.t('Will run out before reset');
    case 'exhausted':
      return vscode.l10n.t('Allowance used up');
    case 'unlimited':
      return vscode.l10n.t('Unlimited');
  }
}

/** "Use it or lose it" message shown in the dashboard and as notification. */
export function surplusMessage(snap: QuotaSnapshot, unused: number): string {
  return vscode.l10n.t(
    'About {0} {1} will expire unused on {2}. A good time for demanding tasks with a premium model: refactoring, reviews, tests.',
    fmt(unused),
    unitLabel(snap),
    fmtDate(snap.resetDate),
  );
}
