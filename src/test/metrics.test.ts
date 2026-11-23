import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, usageCurve } from '../core/metrics';
import { compact as compactHistory } from '../core/history';
import { QuotaSnapshot } from '../core/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function snap(used: number, now: number): QuotaSnapshot {
  return {
    entitlement: 300,
    used,
    remaining: 300 - used,
    unlimited: false,
    overagePermitted: false,
    overageCount: 0,
    resetDate: '2026-12-01T00:00:00.000Z',
    unit: 'requests',
    quotaId: 'premium_interactions',
    fetchedAt: now,
  };
}

const opts = { countWeekends: true, reserve: 0 };

test('curve starts at 0 at cycle start and ends at current usage', () => {
  const now = Date.UTC(2026, 10, 15, 12);
  const { at, start } = usageCurve(snap(100, now), [], now);
  assert.equal(start, Date.UTC(2026, 10, 1));
  assert.equal(at(start), 0);
  assert.equal(at(now), 100);
});

test('today and last7Days come from history', () => {
  const now = Date.UTC(2026, 10, 20, 15);
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const history = [
    { t: now - 10 * DAY, used: 50 },
    { t: now - 7 * DAY, used: 80 },
    { t: dayStart.getTime() - HOUR, used: 140 },
    { t: dayStart.getTime() + HOUR, used: 140 },
  ];
  const m = computeMetrics(snap(150, now), history, opts, now);
  assert.equal(m.today, 10);
  assert.equal(m.last7Days, 70);
});

test('buffer is positive when below plan and negative when above', () => {
  const now = Date.UTC(2026, 10, 16); // exactly half of November
  const below = computeMetrics(snap(100, now), [], opts, now);
  assert.ok(Math.abs(below.buffer - 50) < 1e-6);
  assert.ok(Math.abs(below.bufferDays - 5) < 1e-6); // plan = 10/day
  const above = computeMetrics(snap(200, now), [], opts, now);
  assert.ok(Math.abs(above.buffer + 50) < 1e-6);
});

test('daily buckets cover the cycle, flag estimated days and sum to used', () => {
  const now = Date.UTC(2026, 10, 10, 12);
  const history = [
    { t: Date.UTC(2026, 10, 8, 12), used: 60 },
    { t: Date.UTC(2026, 10, 9, 12), used: 70 },
  ];
  const m = computeMetrics(snap(90, now), history, opts, now);
  const total = m.daily.reduce((s, d) => s + d.used, 0);
  assert.ok(Math.abs(total - 90) < 1e-6);
  assert.ok(m.daily[0].estimated);
  assert.equal(m.daily[m.daily.length - 1].estimated, false);
  assert.ok(m.daily.length >= 10 && m.daily.length <= 11);
});

test('streak counts finished days within plan until an over-plan day', () => {
  const now = Date.UTC(2026, 10, 10, 12);
  // Plan is 10/day. Days 1..5 heavy (estimated), then real data with 5/day.
  const base = Date.UTC(2026, 10, 6, 0, 30);
  const history = [
    { t: base, used: 100 },
    { t: base + 1 * DAY, used: 105 },
    { t: base + 2 * DAY, used: 110 },
    { t: base + 3 * DAY, used: 115 },
    { t: base + 4 * DAY, used: 120 },
  ];
  const m = computeMetrics(snap(122, now), history, opts, now);
  assert.ok(m.streakDays >= 2, `streak ${m.streakDays}`);
  assert.ok(m.streakDays <= 4);
});

test('compaction keeps recent points and thins old ones to one per hour', () => {
  const now = Date.UTC(2026, 10, 20);
  const old = Array.from({ length: 6 }, (_, i) => ({ t: now - 5 * DAY + i * 10 * 60_000, used: i }));
  const recent = Array.from({ length: 6 }, (_, i) => ({ t: now - HOUR + i * 5 * 60_000, used: 10 + i }));
  const out = compactHistory([...old, ...recent], now);
  assert.equal(out.filter((p) => p.t < now - 2 * DAY).length, 1);
  assert.equal(out.filter((p) => p.t >= now - 2 * DAY).length, 6);
  assert.equal(out.find((p) => p.t < now - 2 * DAY)?.used, 5);
});
