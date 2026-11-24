import { computeMetrics } from './metrics';
import { ForecastOptions, HistoryPoint, QuotaSnapshot } from './types';

/** Compact summary of one billing cycle, archived when a new cycle starts. */
export interface CycleSummary {
  /** Reset date (ISO) that ended this cycle; identifies the cycle. */
  resetDate: string;
  used: number;
  entitlement: number;
  unit: QuotaSnapshot['unit'];
  activeDays: number;
  avgPerActiveDay: number;
  peakDay?: { date: string; used: number };
  /** Estimated need for the whole cycle at the observed pace. */
  demand?: number;
}

export const MAX_CYCLES = 12;

/** Summarises a cycle from its last snapshot and recorded history. */
export function summarizeCycle(snap: QuotaSnapshot, history: HistoryPoint[], opts: ForecastOptions, now: number): CycleSummary {
  const m = computeMetrics(snap, history, opts, now);
  const real = m.daily.filter((d) => !d.estimated);
  const active = real.filter((d) => d.used >= 0.5);
  const peak = real.reduce<{ date: string; used: number } | undefined>(
    (best, d) => (d.used > (best?.used ?? 0) ? { date: d.date, used: d.used } : best),
    undefined,
  );
  return {
    resetDate: snap.resetDate,
    used: snap.used,
    entitlement: snap.entitlement,
    unit: snap.unit,
    activeDays: active.length,
    avgPerActiveDay: active.length > 0 ? active.reduce((s, d) => s + d.used, 0) / active.length : 0,
    peakDay: peak ? { date: peak.date, used: Math.round(peak.used) } : undefined,
    demand: m.demand ? Math.round(m.demand.estimate) : undefined,
  };
}

/** Adds a summary, replacing one for the same cycle, newest first, capped. */
export function addCycle(cycles: CycleSummary[], c: CycleSummary): CycleSummary[] {
  const key = c.resetDate.slice(0, 10);
  const rest = cycles.filter((x) => x.resetDate.slice(0, 10) !== key);
  return [c, ...rest].sort((a, b) => b.resetDate.localeCompare(a.resetDate)).slice(0, MAX_CYCLES);
}
