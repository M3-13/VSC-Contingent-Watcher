import * as vscode from 'vscode';
import { IconStyle } from './core/appearance';

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
  accent: string;
  statusBarIcon: IconStyle;
  statusBarColor: string;
  surplusHint: boolean;
  activityTracking: boolean;
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
    accent: c.get<string>('appearance.accentColor', 'auto'),
    statusBarIcon: c.get<IconStyle>('statusBar.icon', 'gauge'),
    statusBarColor: c.get<string>('statusBar.color', 'auto'),
    surplusHint: c.get<boolean>('warnings.surplusHint', true),
    activityTracking: c.get<boolean>('activity.enabled', true),
  };
}
