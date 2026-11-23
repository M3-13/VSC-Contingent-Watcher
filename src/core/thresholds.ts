/**
 * Returns the highest threshold that was newly crossed, or undefined.
 * `alreadyNotified` holds thresholds already shown in this cycle.
 */
export function newlyCrossedThreshold(
  usedPercent: number,
  thresholds: number[],
  alreadyNotified: number[],
): number | undefined {
  const crossed = [...new Set(thresholds)]
    .filter((t) => t > 0 && usedPercent >= t && !alreadyNotified.includes(t))
    .sort((a, b) => b - a);
  return crossed[0];
}

/** Stable key identifying a billing cycle, used to reset notification state. */
export function cycleKey(resetDate: string): string {
  return resetDate.slice(0, 10);
}
