import { QuotaSnapshot, QuotaUnit } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const IGNORED = new Set(['chat', 'completions']);
const PREFERRED = ['premium_interactions', 'ai_credits', 'credits', 'premium_requests'];

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** First day of next month, 00:00 UTC — GitHub's documented reset time. */
export function defaultResetDate(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

function normaliseReset(raw: unknown, now: number): string {
  if (typeof raw === 'string' && raw.length > 0) {
    // "YYYY-MM-DD" is treated as 00:00 UTC.
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) {
      return new Date(t).toISOString();
    }
  }
  return defaultResetDate(now);
}

/**
 * Parses the (undocumented) `copilot_internal/user` response defensively.
 * Every field is optional; returns undefined if no metered quota is found.
 */
export function parseCopilotUser(body: any, now: number = Date.now()): QuotaSnapshot | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const snapshots: Record<string, any> = body.quota_snapshots ?? {};
  const keys = Object.keys(snapshots);
  const key =
    PREFERRED.find((k) => snapshots[k]) ??
    keys.find((k) => !IGNORED.has(k) && snapshots[k] && !snapshots[k].unlimited) ??
    keys.find((k) => !IGNORED.has(k));
  if (!key) {
    return undefined;
  }
  const q = snapshots[key] ?? {};

  const unlimited = q.unlimited === true;
  const entitlement = num(q.entitlement) ?? 0;
  let remaining = num(q.remaining) ?? num(q.quota_remaining);
  const pct = num(q.percent_remaining);
  if (remaining === undefined && pct !== undefined) {
    remaining = (entitlement * pct) / 100;
  }
  remaining = Math.max(0, remaining ?? entitlement);
  const used = Math.max(0, entitlement - remaining);

  const unit: QuotaUnit = /credit/i.test(key) ? 'credits' : 'requests';

  return {
    entitlement,
    used,
    remaining,
    unlimited,
    overagePermitted: q.overage_permitted === true,
    overageCount: num(q.overage_count) ?? 0,
    resetDate: normaliseReset(body.quota_reset_date_utc ?? body.quota_reset_date, now),
    unit,
    quotaId: key,
    plan: typeof body.copilot_plan === 'string' ? body.copilot_plan : undefined,
    fetchedAt: now,
  };
}
