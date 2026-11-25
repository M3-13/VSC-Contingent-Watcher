import { Forecast, ForecastOptions, HistoryPoint, QuotaSnapshot } from './types';

const DAY = 24 * 60 * 60 * 1000;
/** Window used to compute the recent burn rate (local days, incl. today). */
const RECENT_WINDOW_DAYS = 7;
/** Tolerance for floating-point comparisons of budget-day counts. */
const EPS = 1e-9;

/*
 * Day logic uses LOCAL time throughout (local weekday, local midnight), the
 * same as the chart and every date shown to the user. Only the cycle start
 * and the reset are absolute instants (GitHub resets at 00:00 UTC), so a
 * cycle may begin or end part-way through a local day.
 */

/** Local midnight of the day containing t. */
export function localDayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight of the day after the one containing t (DST-safe). */
export function nextLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Monday–Friday (0 = Sunday … 6 = Saturday). */
export const DEFAULT_WORK_DAYS: readonly number[] = [1, 2, 3, 4, 5];

/** True if the local day of t is a work day. An empty list counts every day. */
export function isWorkDay(t: number, workDays: readonly number[]): boolean {
  return workDays.length === 0 || workDays.includes(new Date(t).getDay());
}

/** Cycle start = reset date minus one calendar month (UTC). */
export function cycleStart(reset: Date): Date {
  return new Date(Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() - 1, reset.getUTCDate()));
}

/**
 * Budget days between [from, to): work time on local work days, in units of
 * 24 h (a full day counts 1, a partial day its fraction).
 */
export function budgetDays(from: number, to: number, workDays: readonly number[]): number {
  if (to <= from) {
    return 0;
  }
  let total = 0;
  for (let day = localDayStart(from); day < to; day = nextLocalDay(day)) {
    if (!isWorkDay(day, workDays)) {
      continue;
    }
    const start = Math.max(day, from);
    const end = Math.min(nextLocalDay(day), to);
    total += Math.max(0, end - start) / DAY;
  }
  return total;
}

/**
 * Adds n budget days to t (skipping local days off). If the budget ends
 * exactly at the end of a work day, the result stays on that day (1 ms
 * before midnight) so the displayed date is the work day, not the next day.
 */
export function addBudgetDays(t: number, n: number, workDays: readonly number[]): Date {
  let cursor = t;
  let left = n;
  // Hard cap to avoid infinite loops on bad input.
  for (let i = 0; i < 400 && left > 0; i++) {
    const dayEnd = nextLocalDay(cursor);
    if (!isWorkDay(cursor, workDays)) {
      cursor = dayEnd;
      continue;
    }
    const avail = (dayEnd - cursor) / DAY;
    if (left <= avail) {
      return new Date(Math.min(cursor + left * DAY, dayEnd - 1));
    }
    left -= avail;
    cursor = dayEnd;
  }
  return new Date(cursor);
}

/**
 * End of the pace period: the end of today's local day (capped at reset).
 * Pace is day-granular: today counts as a full budget day, since work is
 * done in office hours, not spread evenly over 24 h.
 */
function paceEnd(now: number, resetMs: number): number {
  return Math.min(resetMs, nextLocalDay(now));
}

/** Budget days from cycle start through the end of today (today counts fully). */
export function paceDays(cycleStartMs: number, resetMs: number, now: number, workDays: readonly number[]): number {
  return budgetDays(cycleStartMs, paceEnd(now, resetMs), workDays);
}

/**
 * Requests per budget day over the last RECENT_WINDOW_DAYS local days
 * (incl. today, counted as a full budget day): usage since local midnight
 * at the window start, divided by the budget days of those whole days.
 * Undefined without history from before the window (unless it starts at
 * cycle start, where usage is 0 by definition) or with too few budget days.
 */
export function recentBurnRate(
  history: HistoryPoint[],
  now: number,
  cycleStartMs: number,
  workDays: readonly number[],
  usedNow?: number,
  resetMs: number = Infinity,
): number | undefined {
  const d = new Date(now);
  const windowStart = Math.max(
    cycleStartMs,
    new Date(d.getFullYear(), d.getMonth(), d.getDate() - (RECENT_WINDOW_DAYS - 1)).getTime(),
  );
  const pts = history.filter((p) => p.t <= now).sort((a, b) => a.t - b.t);
  const current = usedNow ?? pts[pts.length - 1]?.used;
  if (current === undefined) {
    return undefined;
  }
  let base: number | undefined;
  if (windowStart <= cycleStartMs) {
    base = 0;
  } else {
    // Usage at the window start, interpolated between the surrounding points.
    const i = pts.findIndex((p) => p.t > windowStart);
    const a = i === -1 ? pts[pts.length - 1] : pts[i - 1];
    const b = i === -1 ? undefined : pts[i];
    if (a) {
      base = b ? a.used + ((b.used - a.used) * (windowStart - a.t)) / (b.t - a.t) : a.used;
    }
  }
  if (base === undefined) {
    return undefined;
  }
  const days = budgetDays(windowStart, paceEnd(now, resetMs), workDays);
  // Need at least ~half a budget day to be meaningful.
  if (days < 0.5) {
    return undefined;
  }
  return Math.max(0, current - base) / days;
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

  // Day-granular pace (see paceEnd): budget days through the end of today,
  // completed budget days before today, and budget days after today.
  const todayStart = localDayStart(now);
  const paceElapsed = paceDays(startMs, resetMs, now, opts.workDays);
  const completedDays = budgetDays(startMs, Math.min(todayStart, resetMs), opts.workDays);
  const daysAfterToday = budgetDays(Math.max(paceEnd(now, resetMs), startMs), resetMs, opts.workDays);

  const usedPercent = snap.entitlement > 0 ? (snap.used / snap.entitlement) * 100 : 0;
  const expectedUsed = snap.entitlement * Math.min(1, paceElapsed / totalDays);
  const paceRatio = expectedUsed > 0 ? snap.used / expectedUsed : snap.used > 0 ? Infinity : 0;

  const spendable = Math.max(0, snap.remaining - opts.reserve);
  const dailyBudget = daysLeft > 0 ? spendable / Math.max(daysLeft, 1) : 0;

  const average = paceElapsed >= 1 - EPS ? snap.used / paceElapsed : undefined;
  const burnRate = recentBurnRate(history, now, startMs, opts.workDays, snap.used, resetMs) ?? average ?? 0;
  // Today is already accounted for as a full day in the rate, so only the
  // budget days after today are projected.
  const projectedUsed = snap.used + burnRate * daysAfterToday;

  // Only when the allowance would run out at least half a budget day before
  // reset: below that the day-granular forecast can't tell (e.g. a reset at
  // 01:00 local time leaves a one-hour sliver of budget on the last day).
  let exhaustionDate: Date | undefined;
  if (burnRate > 0 && snap.remaining > 0 && snap.remaining / burnRate < daysAfterToday - 0.5) {
    exhaustionDate = addBudgetDays(now, snap.remaining / burnRate, opts.workDays);
  }

  // Warnings about the pace need at least one completed budget day of data.
  const enoughData = completedDays >= 1 - EPS;
  let status: Forecast['status'];
  if (snap.unlimited) {
    status = 'unlimited';
  } else if (snap.remaining <= 0) {
    status = 'exhausted';
  } else if (enoughData && exhaustionDate && exhaustionDate.getTime() < resetMs - 3 * DAY) {
    status = 'critical';
  } else if (enoughData && paceRatio > 1.15 && snap.used >= 5) {
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
