import { Forecast, ForecastOptions, HistoryPoint, QuotaSnapshot } from './types';

const DAY = 24 * 60 * 60 * 1000;
/** Window used to compute the recent burn rate. */
const RECENT_WINDOW_DAYS = 7;

function startOfUtcDay(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Monday–Friday (0 = Sunday … 6 = Saturday). */
export const DEFAULT_WORK_DAYS: readonly number[] = [1, 2, 3, 4, 5];

/** True if the (UTC) day of t is a work day. An empty list counts every day. */
export function isWorkDay(t: number, workDays: readonly number[]): boolean {
  return workDays.length === 0 || workDays.includes(new Date(t).getUTCDay());
}

/** Cycle start = reset date minus one calendar month (UTC). */
export function cycleStart(reset: Date): Date {
  return new Date(Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() - 1, reset.getUTCDate()));
}

/**
 * Budget days between [from, to): a day counts fully, the current day counts
 * with its remaining fraction. Only the given work days count.
 */
export function budgetDays(from: number, to: number, workDays: readonly number[]): number {
  if (to <= from) {
    return 0;
  }
  let total = 0;
  for (let day = startOfUtcDay(from); day < to; day += DAY) {
    if (!isWorkDay(day, workDays)) {
      continue;
    }
    const start = Math.max(day, from);
    const end = Math.min(day + DAY, to);
    total += Math.max(0, end - start) / DAY;
  }
  return total;
}

/** Adds n budget days to t (skipping days off). */
export function addBudgetDays(t: number, n: number, workDays: readonly number[]): Date {
  let cursor = t;
  let left = n;
  // Hard cap to avoid infinite loops on bad input.
  for (let i = 0; i < 400 && left > 0; i++) {
    const dayEnd = startOfUtcDay(cursor) + DAY;
    if (!isWorkDay(cursor, workDays)) {
      cursor = dayEnd;
      continue;
    }
    const avail = (dayEnd - cursor) / DAY;
    if (left <= avail) {
      return new Date(cursor + left * DAY);
    }
    left -= avail;
    cursor = dayEnd;
  }
  return new Date(cursor);
}

/** Requests per budget day over the recent window, from history points. */
export function recentBurnRate(history: HistoryPoint[], now: number, cycleStartMs: number, workDays: readonly number[]): number | undefined {
  const windowStart = Math.max(cycleStartMs, now - RECENT_WINDOW_DAYS * DAY);
  const pts = history.filter((p) => p.t >= windowStart && p.t <= now).sort((a, b) => a.t - b.t);
  if (pts.length < 2) {
    return undefined;
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  const days = budgetDays(first.t, last.t, workDays);
  // Need at least ~half a budget day of data to be meaningful.
  if (days < 0.5) {
    return undefined;
  }
  return Math.max(0, last.used - first.used) / days;
}

export function computeForecast(
  snap: QuotaSnapshot,
  history: HistoryPoint[],
  opts: ForecastOptions,
  now: number = Date.now(),
): Forecast {
  const reset = new Date(snap.resetDate);
  const startMs = cycleStart(reset).getTime();
  const resetMs = reset.getTime();

  const totalDays = Math.max(budgetDays(startMs, resetMs, opts.workDays), 1e-6);
  const elapsedDays = budgetDays(startMs, Math.min(now, resetMs), opts.workDays);
  const daysLeft = budgetDays(Math.max(now, startMs), resetMs, opts.workDays);
  const cycleElapsed = Math.min(1, elapsedDays / totalDays);

  const usedPercent = snap.entitlement > 0 ? (snap.used / snap.entitlement) * 100 : 0;
  const expectedUsed = snap.entitlement * cycleElapsed;
  const paceRatio = expectedUsed > 0 ? snap.used / expectedUsed : snap.used > 0 ? Infinity : 0;

  const spendable = Math.max(0, snap.remaining - opts.reserve);
  const dailyBudget = daysLeft > 0 ? spendable / Math.max(daysLeft, 1) : 0;

  const average = elapsedDays >= 1 ? snap.used / elapsedDays : undefined;
  const burnRate = recentBurnRate(history, now, startMs, opts.workDays) ?? average ?? 0;
  const projectedUsed = snap.used + burnRate * daysLeft;

  let exhaustionDate: Date | undefined;
  if (burnRate > 0 && projectedUsed > snap.entitlement && snap.remaining > 0) {
    exhaustionDate = addBudgetDays(now, snap.remaining / burnRate, opts.workDays);
  }

  let status: Forecast['status'];
  if (snap.unlimited) {
    status = 'unlimited';
  } else if (snap.remaining <= 0) {
    status = 'exhausted';
  } else if (exhaustionDate && exhaustionDate.getTime() < resetMs - 3 * DAY) {
    status = 'critical';
  } else if (paceRatio > 1.15 && snap.used >= 5) {
    status = 'ahead';
  } else {
    status = 'onTrack';
  }

  return {
    usedPercent,
    cycleElapsed,
    paceRatio,
    daysLeft,
    dailyBudget,
    burnRate,
    projectedUsed,
    exhaustionDate,
    status,
  };
}
