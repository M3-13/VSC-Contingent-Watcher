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
    /** exhausted = allowance was already empty at the start of that day. */
    daily: { date: string; used: number; weekend: boolean; estimated: boolean; exhausted: boolean }[];
    /** Budget per day for the chart reference line (entitlement / budget days of cycle). */
    planPerDay: number;
    /**
     * Estimated need for the whole cycle at the observed pace, also when the
     * allowance already ran out ("how much would I have needed to get by?").
     * Undefined with too little data. planPerDay is the max/day to get by.
     */
    demand?: { estimate: number; overBy: number; exhaustedOn?: string };
  };
  tips: { id: string; text: string; relevant: boolean }[];
  /** Visual customisation. */
  appearance: {
    /** CSS colour for the gauge/accent; undefined = theme default (charts colours). */
    accentColor?: string;
  };
  /**
   * Set near the end of a cycle when a noticeable part of the allowance will
   * likely expire unused ("use it or lose it").
   */
  surplus?: {
    /** Requests/credits expected to remain unused at reset. */
    expectedUnused: number;
    /** Translated one-line message ready to display. */
    message: string;
  };
  /** Usage per model from the official billing API (opt-in, needs a token). */
  models: {
    state: 'notConfigured' | 'loading' | 'ok' | 'error';
    errorMessage?: string;
    /** Sorted by quantity, descending. share is 0..1 of the total. */
    /** credits is set when the report has amounts (1 credit = $0.01); share is by credits then. */
    items: { model: string; quantity: number; credits?: number; share: number }[];
    /** e.g. "November 2026". */
    periodLabel?: string;
    /** True when items carry credits (show credits instead of request counts). */
    showCredits?: boolean;
  };
  /** Month-over-month review from archived cycles (newest first, max 6). */
  review: {
    cycles: {
      /** Cycle label, e.g. "Oktober 2026". */
      label: string;
      used: number;
      entitlement: number;
      /** Average per active day. */
      avgPerActiveDay: number;
      activeDays: number;
      peakDay?: { date: string; used: number };
      /** Estimated need for that cycle at its pace (may exceed entitlement). */
      demand?: number;
      /** True for the running cycle (partial data). */
      current: boolean;
    }[];
  };
  /** What was worked on and how long it took (per git branch, active time only). */
  activity: {
    enabled: boolean;
    items: {
      id: string;
      /** Human-readable title (branch name, or "main · 24 Nov"). */
      title: string;
      /** Last commit message on that branch, if known. */
      detail?: string;
      repo: string;
      /** Epoch ms of first and last activity. */
      start: number;
      end: number;
      activeMinutes: number;
      /** Quota used while this item was active. */
      used: number;
      active: boolean;
    }[];
  };
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
    /** Accent preset id or a #hex colour. */
    accent: string;
    /** Status bar icon style. */
    statusBarIcon: 'gauge' | 'battery' | 'ring' | 'bars' | 'none';
    /** Status bar text/icon colour: 'auto' or a #hex colour. */
    statusBarColor: string;
    surplusHint: boolean;
    activityTracking: boolean;
    billingTokenSet: boolean;
    refreshIntervalMinutes: number;
    alignment: 'left' | 'right';
    /** Optional API base URL override (empty = automatic). */
    apiUrl: string;
    /** Which model btw uses: the current chat model or a free (included) model. */
    btwModel: 'chat' | 'included';
    /** Which quota to show if GitHub reports both: credits (usage-based) or requests. */
    unit: 'auto' | 'credits' | 'requests';
    /** Included model families btw may use in 'included' mode, in order. */
    preferredModels: string[];
    /** Include the current Copilot chat conversation as btw context. */
    btwIncludeChat: boolean;
    /**
     * Copilot's own options, discovered at runtime from the installed Copilot
     * extension (undefined = not available in this Copilot version).
     */
    copilotEagerness?: { value: string; options: string[] };
    /** Completions for the language of the active editor. */
    copilotLanguage?: { id: string; label: string; enabled: boolean };
    /** Copilot offers a "snooze completions" command. */
    copilotSnoozeAvailable: boolean;
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
  | 'openWalkthrough'
  | 'configureBillingToken'
  | 'clearBillingToken'
  | 'clearActivity'
  | 'btw'
  | 'snoozeCompletions';

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
  | 'copilotNextEdit'
  | 'accent'
  | 'statusBarIcon'
  | 'statusBarColor'
  | 'surplusHint'
  | 'activityTracking'
  | 'refreshIntervalMinutes'
  | 'alignment'
  | 'apiUrl'
  | 'preferredModels'
  | 'btwModel'
  | 'unit'
  | 'btwIncludeChat'
  | 'copilotEagerness'
  | 'copilotLanguage';

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'command'; command: DashboardCommand }
  | { type: 'setSetting'; key: DashboardSettingKey; value: unknown };

export type ExtensionMessage = { type: 'model'; model: DashboardModel };
