import { Forecast, QuotaSnapshot } from './types';

const DAY = 24 * 60 * 60 * 1000;

/** Days before reset in which the "use it or lose it" hint may appear. */
export const SURPLUS_WINDOW_DAYS = 7;

/**
 * Expected unused allowance at reset, if it is worth mentioning:
 * only in the last week of the cycle and when at least 10 % (min. 10)
 * of the allowance would expire.
 */
export function expectedSurplus(snap: QuotaSnapshot, f: Forecast, now: number = Date.now()): number | undefined {
  if (snap.unlimited || snap.entitlement <= 0) {
    return undefined;
  }
  const untilReset = new Date(snap.resetDate).getTime() - now;
  if (untilReset <= 0 || untilReset > SURPLUS_WINDOW_DAYS * DAY) {
    return undefined;
  }
  const unused = snap.entitlement - f.projectedUsed;
  const threshold = Math.max(10, snap.entitlement * 0.1);
  return unused >= threshold ? Math.floor(unused) : undefined;
}
