/** Pure model selection logic (no vscode import, unit-testable). */

export interface ModelInfo {
  family: string;
  name?: string;
}

export function matchesFamily(modelFamily: string, preferred: string): boolean {
  const m = modelFamily.trim().toLowerCase();
  const p = preferred.trim().toLowerCase();
  if (!m || !p) {
    return false;
  }
  return m === p || m.startsWith(p + '-') || m.startsWith(p);
}

/**
 * Pick the first available model matching the preferred families, in order of
 * preference. Exact matches win over prefix matches within one preference.
 * Returns undefined if none match (never falls back to an arbitrary model).
 */
export function chooseModel<T extends ModelInfo>(available: readonly T[], preferred: readonly string[]): T | undefined {
  for (const pref of preferred) {
    const exact = available.find((m) => m.family.trim().toLowerCase() === pref.trim().toLowerCase());
    if (exact) {
      return exact;
    }
    const prefix = available.find((m) => matchesFamily(m.family, pref));
    if (prefix) {
      return prefix;
    }
  }
  return undefined;
}

export function availableFamilies(available: readonly ModelInfo[]): string[] {
  return [...new Set(available.map((m) => m.family))].sort();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '\n… [truncated]';
}
