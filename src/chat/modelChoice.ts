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

/** Default for `contingentWatcher.chat.preferredModels` (included / 0x model families). */
export const DEFAULT_PREFERRED_MODELS: readonly string[] = ['gpt-5-mini', 'gpt-4.1', 'gpt-4o'];

/** Validates the raw setting value; falls back to the defaults when empty or invalid. */
export function normalizePreferred(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_PREFERRED_MODELS];
  }
  const list = value.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
  return list.length > 0 ? list : [...DEFAULT_PREFERRED_MODELS];
}
