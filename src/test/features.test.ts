import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addActiveTime, addUsage, isActive, itemId } from '../core/activity';
import { fillLevel, iconFor, resolveColor } from '../core/appearance';
import { parseModelUsage } from '../core/billing';
import { addCycle, summarizeCycle } from '../core/cycles';
import { computeForecast } from '../core/forecast';
import { expectedSurplus } from '../core/surplus';
import { QuotaSnapshot } from '../core/types';

const DAY = 86_400_000;

function snap(used: number, now: number, resetDate = '2026-12-01T00:00:00.000Z'): QuotaSnapshot {
  return {
    entitlement: 300,
    used,
    remaining: Math.max(0, 300 - used),
    unlimited: false,
    overagePermitted: false,
    overageCount: 0,
    resetDate,
    unit: 'requests',
    quotaId: 'premium_interactions',
    fetchedAt: now,
  };
}

const opts = { countWeekends: true, reserve: 0 };

test('surplus: shown in the last week when much would expire', () => {
  const now = Date.UTC(2026, 10, 27);
  const s = snap(100, now);
  const unused = expectedSurplus(s, computeForecast(s, [], opts, now), now);
  assert.ok(unused !== undefined && unused > 100);
});

test('surplus: not shown earlier in the month or when on plan', () => {
  const early = Date.UTC(2026, 10, 10);
  const s1 = snap(10, early);
  assert.equal(expectedSurplus(s1, computeForecast(s1, [], opts, early), early), undefined);
  const late = Date.UTC(2026, 10, 27);
  const s2 = snap(270, late);
  assert.equal(expectedSurplus(s2, computeForecast(s2, [], opts, late), late), undefined);
});

test('cycles: summary has peak day and active days; addCycle dedupes and sorts', () => {
  const now = Date.UTC(2026, 10, 30, 20);
  const history = [
    { t: Date.UTC(2026, 10, 28, 1), used: 100 },
    { t: Date.UTC(2026, 10, 28, 23), used: 140 },
    { t: Date.UTC(2026, 10, 29, 23), used: 150 },
  ];
  const sum = summarizeCycle(snap(150, now), history, opts, now);
  assert.equal(sum.used, 150);
  assert.ok(sum.peakDay && sum.peakDay.used >= 30);
  assert.ok(sum.activeDays >= 1);
  const older = { ...sum, resetDate: '2026-11-01T00:00:00.000Z' };
  const list = addCycle(addCycle([older], sum), { ...sum, used: 151 });
  assert.equal(list.length, 2);
  assert.equal(list[0].used, 151);
});

test('activity: feature branches accumulate, default branches split per day', () => {
  const t0 = new Date(2026, 10, 20, 10).getTime();
  let items = addActiveTime([], { repo: 'app', branch: 'feature/login' }, t0, 30_000, 'Add login form');
  items = addActiveTime(items, { repo: 'app', branch: 'feature/login' }, t0 + DAY, 30_000);
  assert.equal(items.length, 1);
  assert.equal(items[0].activeMs, 60_000);
  assert.equal(items[0].detail, 'Add login form');

  items = addActiveTime(items, { repo: 'app', branch: 'main' }, t0, 30_000);
  items = addActiveTime(items, { repo: 'app', branch: 'main' }, t0 + DAY, 30_000);
  assert.equal(items.filter((i) => i.branch === 'main').length, 2);
  assert.notEqual(itemId({ repo: 'app', branch: 'main' }, t0), itemId({ repo: 'app', branch: 'main' }, t0 + DAY));
});

test('activity: usage attribution and active flag', () => {
  const t0 = new Date(2026, 10, 20, 10).getTime();
  const key = { repo: 'app', branch: 'feature/x' };
  let items = addUsage([], key, t0, 3);
  items = addUsage(items, key, t0, 0);
  items = addUsage(items, key, t0, -2);
  assert.equal(items[0].used, 3);
  assert.ok(isActive(items[0], key, t0 + 60_000));
  assert.ok(!isActive(items[0], key, t0 + 60 * 60_000));
  assert.ok(!isActive(items[0], { repo: 'app', branch: 'other' }, t0));
});

test('billing: aggregates usage per model, tolerant to field names', () => {
  const res = parseModelUsage({
    usageItems: [
      { model: 'Claude Opus', grossQuantity: 30 },
      { model: 'Claude Sonnet', grossQuantity: 10 },
      { model: 'Claude Opus', grossQuantity: '20' },
      { model: 'GPT-5 mini', grossQuantity: 0 },
      { sku: 'other', quantity: 10 },
    ],
  });
  assert.deepEqual(
    res.map((r) => [r.model, r.quantity]),
    [
      ['Claude Opus', 50],
      ['Claude Sonnet', 10],
      ['other', 10],
    ],
  );
  assert.ok(Math.abs(res[0].share - 50 / 70) < 1e-9);
  assert.deepEqual(parseModelUsage(null), []);
});

test('appearance: colours, levels and icon ids', () => {
  assert.equal(resolveColor('auto'), undefined);
  assert.equal(resolveColor('teal'), '#14b8a6');
  assert.equal(resolveColor('#ABC'), '#ABC');
  assert.equal(resolveColor('red; injection'), undefined);
  assert.equal(fillLevel(300, 300), 4);
  assert.equal(fillLevel(1, 300), 1);
  assert.equal(fillLevel(0, 300), 0);
  assert.equal(iconFor('gauge', 3), '$(contingent-level-3)');
  assert.equal(iconFor('battery', 2), '$(contingent-battery-2)');
  assert.equal(iconFor('none', 2), '');
});
