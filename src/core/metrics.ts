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
  daily: { date: string; used: number; weekend: boolean; estimated: boolean }[];
  planPerDay: number;
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
    });
  }

  // Consecutive finished days (newest first) within the plan, skipping
  // weekends when they don't count. Estimated days end the streak.
  let streakDays = 0;
  for (let i = daily.length - 2; i >= 0; i--) {
    const day = daily[i];
    if (day.estimated) {
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

  return { today, last7Days, cycleAverage, buffer, bufferDays, streakDays, daily, planPerDay };
}
