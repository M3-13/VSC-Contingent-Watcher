import { HistoryPoint } from './types';

const MAX_POINTS = 2000;
const HOUR = 3_600_000;

/** Keeps full resolution for the last 48h, one point per hour before that. */
export function compact(history: HistoryPoint[], now: number): HistoryPoint[] {
  const cutoff = now - 48 * HOUR;
  const out: HistoryPoint[] = [];
  for (const p of history) {
    const prev = out[out.length - 1];
    if (prev && p.t < cutoff && Math.floor(prev.t / HOUR) === Math.floor(p.t / HOUR)) {
      out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  return out.length > MAX_POINTS ? out.slice(out.length - MAX_POINTS) : out;
}
