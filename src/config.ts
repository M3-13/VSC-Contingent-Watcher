import * as vscode from 'vscode';
import { DEFAULT_TICKET_PATTERN } from './core/activity';
import { IconStyle } from './core/appearance';

export type DisplayMode = 'remaining' | 'used' | 'percent' | 'dailyBudget';

export interface Config {
  refreshIntervalMinutes: number;
  display: DisplayMode;
  alignment: 'left' | 'right';
  thresholds: number[];
  paceWarning: boolean;
  warningsEnabled: boolean;
  /** Work days, 0 = Sunday … 6 = Saturday. */
  workDays: number[];
  reserve: number;
  tipsEnabled: boolean;
  accent: string;
  statusBarIcon: IconStyle;
  statusBarColor: string;
  surplusHint: boolean;
  activityTracking: boolean;
  /** Regex source for ticket ids in commit messages and branch names. */
  ticketPattern: string;
  /** Ticket link template with an {id} placeholder (empty = no links). */
  ticketUrl: string;
}

export const SECTION = 'contingentWatcher';

export const WEEKDAY_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Reads budget.workDays; falls back to the old countWeekends flag, then Mon–Fri. */
function readWorkDays(c: vscode.WorkspaceConfiguration): number[] {
  const configured = c.inspect<string[]>('budget.workDays');
  const explicit = configured?.workspaceFolderValue ?? configured?.workspaceValue ?? configured?.globalValue;
  if (Array.isArray(explicit)) {
    const days = [...new Set(explicit.map((d) => WEEKDAY_IDS.indexOf(String(d).toLowerCase() as (typeof WEEKDAY_IDS)[number])))]
      .filter((d) => d >= 0)
      .sort((a, b) => a - b);
    if (days.length > 0) {
      return days;
    }
  }
  return c.get<boolean>('budget.countWeekends', false) ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
}

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
    workDays: readWorkDays(c),
    reserve: Math.max(0, c.get<number>('budget.reserve', 0)),
    tipsEnabled: c.get<boolean>('tips.enabled', true),
    accent: c.get<string>('appearance.accentColor', 'auto'),
    statusBarIcon: c.get<IconStyle>('statusBar.icon', 'gauge'),
    statusBarColor: c.get<string>('statusBar.color', 'auto'),
    surplusHint: c.get<boolean>('warnings.surplusHint', true),
    activityTracking: c.get<boolean>('activity.enabled', true),
    ticketPattern: c.get<string>('activity.ticketPattern', DEFAULT_TICKET_PATTERN),
    ticketUrl: c.get<string>('activity.ticketUrl', '').trim(),
  };
}
