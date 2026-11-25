export type QuotaUnit = 'requests' | 'credits';

/** Normalised quota snapshot, independent of the data source. */
export interface QuotaSnapshot {
  /** Monthly allowance (credits or premium requests, see unit). */
  entitlement: number;
  /** Allowance used in the current cycle. */
  used: number;
  /** Allowance remaining in the current cycle (never negative). */
  remaining: number;
  /** True if the plan has no limit. */
  unlimited: boolean;
  /** Paid overage enabled (requests beyond the allowance are billed). */
  overagePermitted: boolean;
  /** Requests billed beyond the allowance in this cycle. */
  overageCount: number;
  /** Next reset as ISO timestamp (UTC). */
  resetDate: string;
  /** Billing unit: legacy premium requests or usage-based AI credits. */
  unit: QuotaUnit;
  /** Raw quota id from the API (e.g. "premium_interactions"). */
  quotaId: string;
  /** Plan identifier as reported by GitHub, e.g. "individual", "business". */
  plan?: string;
  /** When the snapshot was fetched (epoch ms). */
  fetchedAt: number;
}

/** A point in the usage history, persisted to compute burn rate. */
export interface HistoryPoint {
  t: number;
  used: number;
}

export interface ForecastOptions {
  /** Work days (0 = Sunday … 6 = Saturday); the budget is spread over these only. */
  workDays: readonly number[];
  /** Requests to keep in reserve; excluded from the daily budget. */
  reserve: number;
}

export type PaceStatus = 'onTrack' | 'ahead' | 'critical' | 'exhausted' | 'unlimited';

export interface Forecast {
  usedPercent: number;
  /** Fraction (0..1) of the cycle (in budget days) that has elapsed. */
  cycleElapsed: number;
  /** Used / linearly expected usage. 1.0 = exactly on plan. */
  paceRatio: number;
  /** Budget days (workdays or calendar days) left including today. */
  daysLeft: number;
  /** Requests per budget day you can spend from now until reset. */
  dailyBudget: number;
  /** Observed requests per budget day (recent window, fallback: cycle average). */
  burnRate: number;
  /** Projected usage at reset if the burn rate continues. */
  projectedUsed: number;
  /** Estimated date the allowance runs out, if before reset. */
  exhaustionDate?: Date;
  status: PaceStatus;
}
