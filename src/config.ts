import * as vscode from 'vscode';

export type DisplayMode = 'remaining' | 'used' | 'percent' | 'dailyBudget';

export interface Config {
  refreshIntervalMinutes: number;
  display: DisplayMode;
  alignment: 'left' | 'right';
  thresholds: number[];
  paceWarning: boolean;
  warningsEnabled: boolean;
  countWeekends: boolean;
  reserve: number;
  tipsEnabled: boolean;
}

export const SECTION = 'contingentWatcher';

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration(SECTION);
  const thresholds = c
    .get<number[]>('warnings.thresholds', [50, 75, 90, 100])
    .filter((n) => typeof n === 'number' && n > 0 && n <= 100);
  return {
    refreshIntervalMinutes: Math.max(2, c.get<number>('refreshIntervalMinutes', 10)),
    display: c.get<DisplayMode>('statusBar.display', 'remaining'),
    alignment: c.get<'left' | 'right'>('statusBar.alignment', 'right'),
    thresholds,
    paceWarning: c.get<boolean>('warnings.paceWarning', true),
    warningsEnabled: c.get<boolean>('warnings.enabled', true),
    countWeekends: c.get<boolean>('budget.countWeekends', false),
    reserve: Math.max(0, c.get<number>('budget.reserve', 0)),
    tipsEnabled: c.get<boolean>('tips.enabled', true),
  };
}
