/**
 * Pure bookkeeping for "what did I work on and how long did it take":
 * active editor time and quota usage per git branch. Default branches are
 * split per day, so "main" doesn't become one endless item.
 */

export interface ActivityKey {
  /** Repository folder name (or workspace name without git). */
  repo: string;
  /** Branch name, undefined without git. */
  branch?: string;
}

export interface ActivityItem {
  id: string;
  repo: string;
  branch?: string;
  /** Local date (YYYY-MM-DD) for per-day items. */
  day?: string;
  detail?: string;
  start: number;
  end: number;
  activeMs: number;
  used: number;
}

export const MAX_ITEMS = 100;
/** No editor activity for this long counts as a pause. */
export const IDLE_MS = 5 * 60 * 1000;
/** An item counts as "active" if it was touched this recently. */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk']);

export function localDate(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isPerDay(key: ActivityKey): boolean {
  return !key.branch || DEFAULT_BRANCHES.has(key.branch.toLowerCase()) || /^HEAD|detached/i.test(key.branch);
}

export function itemId(key: ActivityKey, now: number): string {
  const base = `${key.repo}::${key.branch ?? ''}`;
  return isPerDay(key) ? `${base}::${localDate(now)}` : base;
}

function upsert(items: ActivityItem[], key: ActivityKey, now: number): { items: ActivityItem[]; item: ActivityItem } {
  const id = itemId(key, now);
  const existing = items.find((i) => i.id === id);
  if (existing) {
    return { items, item: existing };
  }
  const item: ActivityItem = {
    id,
    repo: key.repo,
    branch: key.branch,
    day: isPerDay(key) ? localDate(now) : undefined,
    start: now,
    end: now,
    activeMs: 0,
    used: 0,
  };
  return { items: [item, ...items].slice(0, MAX_ITEMS), item };
}

/** Adds active time to the current item. Returns a new array (items are copied). */
export function addActiveTime(items: ActivityItem[], key: ActivityKey, now: number, deltaMs: number, detail?: string): ActivityItem[] {
  const copy = items.map((i) => ({ ...i }));
  const { items: next, item } = upsert(copy, key, now);
  item.activeMs += Math.max(0, deltaMs);
  item.end = now;
  if (detail) {
    item.detail = detail;
  }
  return sortItems(next);
}

/** Attributes quota usage to the current item (only if positive). */
export function addUsage(items: ActivityItem[], key: ActivityKey, now: number, used: number): ActivityItem[] {
  if (!(used > 0)) {
    return items;
  }
  const copy = items.map((i) => ({ ...i }));
  const { items: next, item } = upsert(copy, key, now);
  item.used += used;
  item.end = now;
  return sortItems(next);
}

function sortItems(items: ActivityItem[]): ActivityItem[] {
  return items.sort((a, b) => b.end - a.end).slice(0, MAX_ITEMS);
}

/** True if the item is the one currently being worked on. */
export function isActive(item: ActivityItem, current: ActivityKey | undefined, now: number): boolean {
  return !!current && item.id === itemId(current, now) && now - item.end < ACTIVE_WINDOW_MS;
}
