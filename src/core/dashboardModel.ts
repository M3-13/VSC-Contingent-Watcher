import { PaceStatus } from './types';

/**
 * Data sent from the extension to the dashboard webview. Everything is
 * pre-computed and pre-translated: the webview only renders.
 */
export interface DashboardModel {
  state: 'loading' | 'ok' | 'signedOut' | 'noCopilot' | 'error';
  /** Data is from cache because the last refresh failed. */
  stale: boolean;
  errorMessage?: string;
  /** Auth provider used, e.g. "github" or "github-enterprise". */
  provider?: string;
  /** BCP-47 locale for number/date formatting (vscode.env.language). */
  locale: string;
  /** Translated UI strings, keyed by a stable id (see DASHBOARD_STRINGS). */
  strings: Record<string, string>;
  quota?: {
    unitLabel: string;
    entitlement: number;
    used: number;
    remaining: number;
    usedPercent: number;
    unlimited: boolean;
    overagePermitted: boolean;
    overageCount: number;
    /** ISO timestamp of the next reset. */
    resetDate: string;
    plan?: string;
    /** Epoch ms of the last successful fetch. */
    fetchedAt: number;
  };
  forecast?: {
    status: PaceStatus;
    statusLabel: string;
    /** 0..1 share of the cycle elapsed. */
    cycleElapsed: number;
    /** used / linearly expected usage (1 = on plan). */
    paceRatio: number;
    daysLeft: number;
    dailyBudget: number;
    burnRate: number;
    projectedUsed: number;
    /** ISO date the allowance runs out at the current pace, if before reset. */
    exhaustionDate?: string;
  };
  metrics?: {
    /** Used today (since 00:00 local). */
    today: number;
    /** Used in the last 7 days. */
    last7Days: number;
    /** Average per budget day since cycle start. */
    cycleAverage: number;
    /** Linear plan minus actual usage. Positive = saved vs. plan, negative = over plan. */
    buffer: number;
    /** Buffer expressed in days of daily budget (signed). */
    bufferDays: number;
    /** Consecutive past budget days (excl. today) within the daily budget. */
    streakDays: number;
    /** Usage per calendar day of the current cycle, oldest first, incl. today. */
    /** estimated = before the first recorded data point (spread linearly). */
    daily: { date: string; used: number; weekend: boolean; estimated: boolean }[];
    /** Budget per day for the chart reference line (entitlement / budget days of cycle). */
    planPerDay: number;
  };
  tips: { id: string; text: string; relevant: boolean }[];
  settings: {
    display: 'remaining' | 'used' | 'percent' | 'dailyBudget';
    countWeekends: boolean;
    reserve: number;
    thresholds: number[];
    warningsEnabled: boolean;
    paceWarning: boolean;
    tipsEnabled: boolean;
    authProvider: 'auto' | 'github' | 'github-enterprise';
    /** Epoch ms until warnings are snoozed, if snoozed. */
    snoozedUntil?: number;
    /** Copilot's own toggles (undefined if Copilot is not installed). */
    copilotCompletions?: boolean;
    copilotNextEdit?: boolean;
  };
}

/** Commands the webview can trigger. */
export type DashboardCommand =
  | 'refresh'
  | 'signIn'
  | 'showLog'
  | 'openSettings'
  | 'openBilling'
  | 'manageCopilot'
  | 'openChat'
  | 'snooze'
  | 'unsnooze'
  | 'openWalkthrough';

/** Settings the webview may change directly. */
export type DashboardSettingKey =
  | 'display'
  | 'countWeekends'
  | 'reserve'
  | 'thresholds'
  | 'warningsEnabled'
  | 'paceWarning'
  | 'tipsEnabled'
  | 'authProvider'
  | 'copilotCompletions'
  | 'copilotNextEdit';

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'command'; command: DashboardCommand }
  | { type: 'setSetting'; key: DashboardSettingKey; value: unknown };

export type ExtensionMessage = { type: 'model'; model: DashboardModel };
