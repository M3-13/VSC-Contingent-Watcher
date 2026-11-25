import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBudgetDays, budgetDays, computeForecast, cycleStart } from '../core/forecast';
import { QuotaSnapshot } from '../core/types';

// Expectations are hand-computed for UTC days; work days are local days, so
// pin the time zone for this file (each test file runs in its own process).
process.env.TZ = 'UTC';

const ALL_DAYS: number[] = [];
const WEEKDAYS = [1, 2, 3, 4, 5];

const utc = (m: number, d: number, h = 0) => Date.UTC(2026, m - 1, d, h);
const DAY = 86400000;
// Nov 2026: 1st is a Sunday, 30 days, 9 weekend days.
const NOV1 = utc(11, 1);
const DEC1 = utc(12, 1);
const NOW = utc(11, 16); // Monday, halfway (calendar days)

function close(actual: number, expected: number, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} !~ ${expected}`);
}

function snap(used: number, over: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    entitlement: 300,
    used,
    remaining: Math.max(0, 300 - used),
    unlimited: false,
    overagePermitted: false,
    overageCount: 0,
    resetDate: new Date(DEC1).toISOString(),
    unit: 'requests',
    quotaId: 'premium_interactions',
    fetchedAt: NOW,
    ...over,
  };
}

const OPTS = { workDays: ALL_DAYS, reserve: 0 };

test('cycleStart is one calendar month before reset', () => {
  assert.equal(cycleStart(new Date(DEC1)).getTime(), NOV1);
  assert.equal(cycleStart(new Date(Date.UTC(2027, 0, 1))).getTime(), Date.UTC(2026, 11, 1));
});

test('budgetDays with and without weekends', () => {
  assert.equal(budgetDays(NOV1, DEC1, ALL_DAYS), 30);
  assert.equal(budgetDays(NOV1, DEC1, WEEKDAYS), 21);
  assert.equal(budgetDays(DEC1, NOV1, ALL_DAYS), 0);
  assert.equal(budgetDays(NOV1, NOV1, ALL_DAYS), 0);
});

test('budgetDays counts partial days', () => {
  assert.equal(budgetDays(utc(11, 6, 12), utc(11, 9, 12), WEEKDAYS), 1); // Fri half + Mon half
  assert.equal(budgetDays(utc(11, 6, 12), utc(11, 9, 12), ALL_DAYS), 3);
  assert.equal(budgetDays(utc(11, 7, 6), utc(11, 8, 18), WEEKDAYS), 0);
});

test('addBudgetDays skips weekends', () => {
  assert.equal(addBudgetDays(utc(11, 6, 12), 1, WEEKDAYS).getTime(), utc(11, 9, 12));
  assert.equal(addBudgetDays(utc(11, 6, 12), 1, ALL_DAYS).getTime(), utc(11, 7, 12));
  // From Saturday: all of Monday. Ending exactly at midnight stays on Monday (last ms), so
  // the displayed date is the work day (was utc(11, 10, 0) = Tuesday before the QA fix).
  assert.equal(addBudgetDays(utc(11, 7, 10), 1, WEEKDAYS).getTime(), utc(11, 10, 0) - 1);
  assert.equal(addBudgetDays(utc(11, 16), 7.5, ALL_DAYS).getTime(), utc(11, 23, 12));
});

test('forecast: on track', () => {
  const f = computeForecast(snap(140), [], OPTS, NOW);
  assert.equal(f.status, 'onTrack');
  close(f.cycleElapsed, 0.5);
  close(f.daysLeft, 15);
  close(f.usedPercent, (140 / 300) * 100);
  // Day-granular pace (QA fix): today (Mon 16) counts as a full day → 16 days expected,
  // average 140/16, projected over the 14 days after today (was 140/150, 140/15, 280).
  close(f.paceRatio, 140 / 160);
  close(f.burnRate, 140 / 16);
  close(f.projectedUsed, 140 + (140 / 16) * 14);
  close(f.dailyBudget, 160 / 15);
  assert.equal(f.exhaustionDate, undefined);
});

test('forecast: ahead of pace without early exhaustion', () => {
  // Recent burn is low, so no exhaustion is projected, but pace ratio is 1.2
  // (192 vs 160 expected through the end of today; was 180 vs 150 before the
  // day-granular pace fix).
  const hist = [
    { t: utc(11, 9), used: 190 },
    { t: utc(11, 16), used: 192 },
  ];
  const f = computeForecast(snap(192), hist, OPTS, NOW);
  assert.equal(f.status, 'ahead');
  close(f.paceRatio, 1.2);
  assert.equal(f.exhaustionDate, undefined);
});

test('forecast: critical with exhaustion before reset', () => {
  const f = computeForecast(snap(200), [], OPTS, NOW);
  assert.equal(f.status, 'critical');
  assert.ok(f.exhaustionDate);
  // 100 left at 200/16 = 12.5/day (today counts fully) = 8 days → end of Mon 23 (last ms).
  // Was utc(11, 23, 12): 13.33/day = 7.5 days with the 24 h pace.
  assert.equal(f.exhaustionDate.getTime(), utc(11, 24) - 1);
  assert.ok(f.exhaustionDate.getTime() < DEC1 - 3 * DAY);
});

test('forecast: exhausted', () => {
  const f = computeForecast(snap(300), [], OPTS, NOW);
  assert.equal(f.status, 'exhausted');
  assert.equal(f.dailyBudget, 0);
  assert.equal(f.exhaustionDate, undefined);
});

test('forecast: unlimited', () => {
  const f = computeForecast(snap(0, { unlimited: true, entitlement: 0, remaining: 0 }), [], OPTS, NOW);
  assert.equal(f.status, 'unlimited');
  assert.equal(f.usedPercent, 0);
});

test('forecast: reserve reduces daily budget', () => {
  const base = computeForecast(snap(140), [], OPTS, NOW);
  const withReserve = computeForecast(snap(140), [], { workDays: ALL_DAYS, reserve: 40 }, NOW);
  close(base.dailyBudget, 160 / 15);
  close(withReserve.dailyBudget, 120 / 15);
  const over = computeForecast(snap(140), [], { workDays: ALL_DAYS, reserve: 1000 }, NOW);
  assert.equal(over.dailyBudget, 0);
});

test('forecast: recent burn rate from history overrides average', () => {
  // The window is the last 7 local days incl. today (Nov 10 … 16, today counted fully);
  // the first point now sits at its start (was Nov 9 with the 7 × 24 h window).
  const hist = [
    { t: utc(11, 10), used: 130 },
    { t: utc(11, 16), used: 200 },
  ];
  const f = computeForecast(snap(200), hist, OPTS, NOW);
  close(f.burnRate, 10); // 70 over 7 days, average would be 12.5
  close(f.projectedUsed, 200 + 10 * 14); // budget days after today
});

test('forecast: single history point falls back to average', () => {
  // A point inside the window gives no usage at its start (Nov 10 00:00) → cycle average
  // over 16 days incl. today. (A point at/before the window start is enough since the QA fix:
  // usage is then measured up to the current snapshot.)
  const f = computeForecast(snap(150), [{ t: utc(11, 12), used: 100 }], OPTS, NOW);
  close(f.burnRate, 150 / 16);
});

test('forecast: weekdays only changes days left', () => {
  const f = computeForecast(snap(100), [], { workDays: WEEKDAYS, reserve: 0 }, NOW);
  // Nov 16..Dec 1 contains 11 workdays (16-20, 23-27, 30).
  close(f.daysLeft, 11);
  close(f.cycleElapsed, 10 / 21);
});

test('forecast: start of cycle has no usage and is on track', () => {
  const f = computeForecast(snap(0), [], OPTS, NOV1);
  assert.equal(f.status, 'onTrack');
  assert.equal(f.paceRatio, 0);
  assert.equal(f.burnRate, 0);
});

test('part-time work days: fewer budget days, higher daily budget', () => {
  // November 2026: Mon/Tue/Thu = 13 days (Nov 2 is a Monday).
  const NOV1 = Date.UTC(2026, 10, 1);
  const DEC1 = Date.UTC(2026, 11, 1);
  assert.equal(budgetDays(NOV1, DEC1, [1, 2, 4]), 13);
  // Wednesday is a day off: one budget day from Tue noon ends Thu noon.
  assert.equal(addBudgetDays(Date.UTC(2026, 10, 3, 12), 1, [1, 2, 4]).getTime(), Date.UTC(2026, 10, 5, 12));
});
