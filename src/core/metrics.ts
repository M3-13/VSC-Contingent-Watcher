import { budgetDays, cycleStart } from './forecast';
import { ForecastOptions, HistoryPoint, QuotaSnapshot } from './types';

const DAY = 24 * 60 * 60 * 1000;

export interface UsageMetrics {
  today: number;
  last7Days: number;
  cycleAverage: number;
  buffer: number;
  bufferDays: number;
  streakDays: number;
  daily: { date: string; used: number; weekend: boolean; estimated: boolean; exhausted: boolean }[];
  planPerDay: number;
  demand?: Demand;
}

/** Estimated monthly need at the observed pace (independent of the allowance cap). */
export interface Demand {
  /** What the whole cycle would need at the pace observed so far. */
  estimate: number;
  /** estimate minus allowance (positive = allowance too small). */
  overBy: number;
  /** When the allowance ran out (ISO), if it did. */
  exhaustedOn?: string;
}

/** First time the usage curve reaches `level` (binary search; curve is monotonic). */
function timeReaching(at: (t: number) => number, from: number, to: number, level: number): number | undefined {
  if (at(to) < level) {
    return undefined;
  }
  let lo = from;
  let hi = to;
  for (let i = 0; i < 40 && hi - lo > 60_000; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= level) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

function localDayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function nextLocalDay(t: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localIsoDate(t: number): string {
  const d = new Date(t);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Builds a usage curve from history: starts at 0 at cycle start, ends at the
 * current value, linearly interpolated in between. The stretch before the
 * first real data point is an estimate (extension not yet installed/running).
 */
export function usageCurve(snap: QuotaSnapshot, history: HistoryPoint[], now: number) {
  const start = cycleStart(new Date(snap.resetDate)).getTime();
  const real = history.filter((p) => p.t > start && p.t <= now).sort((a, b) => a.t - b.t);
  const firstReal = real.length > 0 ? real[0].t : now;
  const pts: HistoryPoint[] = [{ t: start, used: 0 }, ...real, { t: now, used: snap.used }];
  // Usage never decreases within a cycle; guard against noisy data.
  for (let i = 1; i < pts.length; i++) {
    pts[i] = { t: pts[i].t, used: Math.max(pts[i].used, pts[i - 1].used) };
  }
  const at = (t: number): number => {
    if (t <= pts[0].t) {
      return 0;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (t <= b.t) {
        return b.t === a.t ? b.used : a.used + ((b.used - a.used) * (t - a.t)) / (b.t - a.t);
      }
    }
    return pts[pts.length - 1].used;
  };
  return { start, firstReal, at };
}

export function computeMetrics(
  snap: QuotaSnapshot,
  history: HistoryPoint[],
  opts: ForecastOptions,
  now: number = Date.now(),
): UsageMetrics {
  const { start, firstReal, at } = usageCurve(snap, history, now);
  const resetMs = new Date(snap.resetDate).getTime();

  const totalDays = Math.max(budgetDays(start, resetMs, opts.countWeekends), 1e-6);
  const elapsedDays = budgetDays(start, Math.min(now, resetMs), opts.countWeekends);
  const planPerDay = snap.entitlement / totalDays;

  const today = Math.max(0, snap.used - at(Math.max(start, localDayStart(now))));
  const last7Days = Math.max(0, snap.used - at(Math.max(start, now - 7 * DAY)));
  const cycleAverage = snap.used / Math.max(1, elapsedDays);

  const expected = snap.entitlement * Math.min(1, elapsedDays / totalDays);
  const buffer = expected - snap.used;
  const bufferDays = planPerDay > 0 ? buffer / planPerDay : 0;

  const daily: UsageMetrics['daily'] = [];
  for (let d = localDayStart(start); d <= now; d = nextLocalDay(d)) {
    const from = Math.max(d, start);
    const to = Math.min(nextLocalDay(d), now);
    const wd = new Date(d).getDay();
    daily.push({
      date: localIsoDate(d),
      used: Math.max(0, at(to) - at(from)),
      weekend: wd === 0 || wd === 6,
      estimated: to <= firstReal,
      // Nothing left to spend from the start of this day on.
      exhausted: snap.entitlement > 0 && at(from) >= snap.entitlement - 1e-6,
    });
  }

  // Consecutive finished days (newest first) within the plan, skipping
  // weekends when they don't count. Estimated days end the streak.
  let streakDays = 0;
  for (let i = daily.length - 2; i >= 0; i--) {
    const day = daily[i];
    // An empty allowance isn't "staying within budget": it ends the streak.
    if (day.estimated || day.exhausted) {
      break;
    }
    if (!opts.countWeekends && day.weekend && day.used === 0) {
      continue;
    }
    if (day.used > planPerDay + 1e-9) {
      break;
    }
    streakDays++;
  }

  return { today, last7Days, cycleAverage, buffer, bufferDays, streakDays, daily, planPerDay, demand: estimateDemand() };

  function estimateDemand(): Demand | undefined {
    if (snap.unlimited || snap.entitlement <= 0) {
      return undefined;
    }
    let rate: number | undefined;
    let exhaustedOn: number | undefined;
    if (snap.overageCount > 0) {
      // Paid overage: real usage keeps counting beyond the allowance.
      rate = elapsedDays >= 1 ? (snap.used + snap.overageCount) / elapsedDays : undefined;
    } else if (snap.remaining <= 0) {
      // Capped at the allowance: use the pace until it ran out.
      exhaustedOn = timeReaching(at, start, now, snap.entitlement - 1e-6);
      const days = exhaustedOn !== undefined ? budgetDays(start, exhaustedOn, opts.countWeekends) : 0;
      rate = days >= 0.5 ? snap.entitlement / days : undefined;
    } else {
      rate = elapsedDays >= 1 ? snap.used / elapsedDays : undefined;
    }
    if (rate === undefined) {
      return undefined;
    }
    const estimate = Math.max(snap.used, rate * totalDays);
    return {
      estimate,
      overBy: estimate - snap.entitlement,
      exhaustedOn: exhaustedOn !== undefined ? new Date(exhaustedOn).toISOString() : undefined,
    };
  }
}
