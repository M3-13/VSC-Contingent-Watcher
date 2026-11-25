import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../core/metrics';
import { QuotaSnapshot } from '../core/types';

// Hand-computed for UTC days (work days are local days); one process per test file.
process.env.TZ = 'UTC';

const ALL_DAYS: number[] = [];

const opts = { workDays: ALL_DAYS, reserve: 0 };

function snap(used: number, now: number, extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    entitlement: 300,
    used,
    remaining: Math.max(0, 300 - used),
    unlimited: false,
    overagePermitted: false,
    overageCount: 0,
    resetDate: '2026-12-01T00:00:00.000Z',
    unit: 'requests',
    quotaId: 'premium_interactions',
    fetchedAt: now,
    ...extra,
  };
}

test('demand extrapolates the pace over the whole month', () => {
  // Half of November, day-granular: Nov 15 counts fully (was Nov 16 00:00, which now counts
  // Nov 16 as a full day too).
  const now = Date.UTC(2026, 10, 15, 18);
  const m = computeMetrics(snap(200, now), [], opts, now);
  assert.ok(m.demand);
  assert.ok(Math.abs(m.demand.estimate - 400) < 1e-6);
  assert.ok(Math.abs(m.demand.overBy - 100) < 1e-6);
  assert.equal(m.demand.exhaustedOn, undefined);
});

test('demand uses the pace until the allowance ran out', () => {
  const now = Date.UTC(2026, 10, 25);
  // 300 used by Nov 11 00:00 (10 days) -> 30/day -> 900 for the month.
  const history = [
    { t: Date.UTC(2026, 10, 6), used: 150 },
    { t: Date.UTC(2026, 10, 11), used: 300 },
    { t: Date.UTC(2026, 10, 20), used: 300 },
  ];
  const m = computeMetrics(snap(300, now), history, opts, now);
  assert.ok(m.demand);
  assert.ok(Math.abs(m.demand.estimate - 900) < 5, `estimate ${m.demand.estimate}`);
  assert.ok(m.demand.exhaustedOn?.startsWith('2026-11-1'));
});

test('demand counts paid overage', () => {
  const now = Date.UTC(2026, 10, 15, 18); // 15 days incl. today, see above
  const m = computeMetrics(snap(300, now, { overagePermitted: true, overageCount: 60 }), [], opts, now);
  assert.ok(m.demand && Math.abs(m.demand.estimate - 720) < 1e-6);
});

test('streak ends on days when the allowance was already empty', () => {
  const now = Date.UTC(2026, 10, 25, 12);
  const history = [
    { t: Date.UTC(2026, 10, 10, 12), used: 299 },
    { t: Date.UTC(2026, 10, 11, 12), used: 300 },
    { t: Date.UTC(2026, 10, 24, 12), used: 300 },
  ];
  const m = computeMetrics(snap(300, now), history, opts, now);
  assert.equal(m.streakDays, 0);
  assert.ok(m.daily.filter((d) => d.exhausted).length >= 10);
});
