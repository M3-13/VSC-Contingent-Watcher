import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBudgetDays, budgetDays, computeForecast, cycleStart } from '../core/forecast';
import { QuotaSnapshot } from '../core/types';

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
  assert.equal(addBudgetDays(utc(11, 7, 10), 1, WEEKDAYS).getTime(), utc(11, 10, 0)); // from Saturday
  assert.equal(addBudgetDays(utc(11, 16), 7.5, ALL_DAYS).getTime(), utc(11, 23, 12));
});

test('forecast: on track', () => {
  const f = computeForecast(snap(140), [], OPTS, NOW);
  assert.equal(f.status, 'onTrack');
  close(f.cycleElapsed, 0.5);
  close(f.daysLeft, 15);
  close(f.usedPercent, (140 / 300) * 100);
  close(f.paceRatio, 140 / 150);
  close(f.burnRate, 140 / 15);
  close(f.projectedUsed, 280);
  close(f.dailyBudget, 160 / 15);
  assert.equal(f.exhaustionDate, undefined);
});

test('forecast: ahead of pace without early exhaustion', () => {
  // Recent burn is low, so no exhaustion is projected, but pace ratio is 1.2.
  const hist = [
    { t: utc(11, 9), used: 178 },
    { t: utc(11, 16), used: 180 },
  ];
  const f = computeForecast(snap(180), hist, OPTS, NOW);
  assert.equal(f.status, 'ahead');
  close(f.paceRatio, 1.2);
  assert.equal(f.exhaustionDate, undefined);
});

test('forecast: critical with exhaustion before reset', () => {
  const f = computeForecast(snap(200), [], OPTS, NOW);
  assert.equal(f.status, 'critical');
  assert.ok(f.exhaustionDate);
  assert.equal(f.exhaustionDate.getTime(), utc(11, 23, 12)); // 100 left at 13.33/day = 7.5 days
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
  const hist = [
    { t: utc(11, 9), used: 130 },
    { t: utc(11, 16), used: 200 },
  ];
  const f = computeForecast(snap(200), hist, OPTS, NOW);
  close(f.burnRate, 10); // 70 over 7 days, average would be 13.33
  close(f.projectedUsed, 200 + 10 * 15);
});

test('forecast: single history point falls back to average', () => {
  const f = computeForecast(snap(150), [{ t: utc(11, 10), used: 100 }], OPTS, NOW);
  close(f.burnRate, 10);
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
