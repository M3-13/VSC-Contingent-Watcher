/**
 * Pure matching of a model reference (from the chat session or a setting)
 * against the available language models. No vscode import (unit-testable).
 *
 * Never guesses across model variants: "gpt-5" does not match "gpt-5-mini",
 * and "claude-sonnet-4.5" does not match "claude-sonnet-4".
 */

export interface LmInfo {
  id: string;
  family: string;
  vendor?: string;
  name?: string;
}

/** Lower-cased reference without a vendor prefix ("copilot/GPT-5" → "gpt-5"). */
export function stripVendor(ref: string): string {
  const r = ref.trim().toLowerCase();
  const i = r.lastIndexOf('/');
  return i >= 0 ? r.slice(i + 1) : r;
}

/** Suffixes that only mark a snapshot of the same model ("gpt-4.1-2025-04-14", "…-preview"). */
const VERSION_SUFFIX = /^(\d{4}|preview|latest|exp)/;

export interface MatchOptions {
  /**
   * Also accept models whose family or id starts with the reference (the shortest
   * wins). Only for references the user typed (e.g. a family in a setting).
   */
  allowPrefix?: boolean;
}

export function matchModel<T extends LmInfo>(models: readonly T[], ref: string | undefined, opts: MatchOptions = {}): T | undefined {
  if (!ref || !ref.trim()) {
    return undefined;
  }
  const full = ref.trim().toLowerCase();
  const bare = stripVendor(full);
  if (!bare) {
    return undefined;
  }
  const lc = (s: string | undefined) => (s ?? '').trim().toLowerCase();

  // 1. Exact id (with or without vendor prefix).
  const byId = models.find((m) => lc(m.id) === bare || lc(m.id) === full || (m.vendor && `${lc(m.vendor)}/${lc(m.id)}` === full));
  if (byId) {
    return byId;
  }
  // 2. Exact family, then exact display name.
  const byFamily = models.find((m) => lc(m.family) === bare);
  if (byFamily) {
    return byFamily;
  }
  const byName = models.find((m) => m.name && lc(m.name) === full);
  if (byName) {
    return byName;
  }
  // 3. The reference is a dated/preview snapshot of an available family or id.
  let best: T | undefined;
  let bestLen = 0;
  for (const m of models) {
    for (const c of [lc(m.family), lc(m.id)]) {
      if (c && bare.startsWith(c + '-') && VERSION_SUFFIX.test(bare.slice(c.length + 1)) && c.length > bestLen) {
        best = m;
        bestLen = c.length;
      }
    }
  }
  if (best) {
    return best;
  }
  // 4. User-typed prefix ("claude-sonnet" → shortest matching family).
  if (opts.allowPrefix) {
    const hits = models.filter((m) => lc(m.family).startsWith(bare) || lc(m.id).startsWith(bare));
    hits.sort((a, b) => lc(a.family).length - lc(b.family).length || lc(a.id).length - lc(b.id).length);
    return hits[0];
  }
  return undefined;
}

/** Value of `contingentWatcher.btw.model` that means "same model as the chat". */
export const BTW_MODEL_FROM_CHAT = 'chat';

export function isChatSetting(value: unknown): boolean {
  return typeof value !== 'string' || !value.trim() || value.trim().toLowerCase() === BTW_MODEL_FROM_CHAT;
}
