import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIPS, pickTip, relevantTips, situationsFor, Situation } from '../core/tips';

test('tip ids are unique and every tip has a situation', () => {
  assert.equal(new Set(TIPS.map((t) => t.id)).size, TIPS.length);
  for (const t of TIPS) {
    assert.ok(t.when.length > 0, t.id);
  }
});

test('situations: surplus first, status, then month phase', () => {
  assert.deepEqual(situationsFor({ status: 'onTrack', cycleElapsed: 0.9, surplus: true }), ['surplus', 'onTrack', 'lateMonth']);
  assert.deepEqual(situationsFor({ status: 'ahead', cycleElapsed: 0.1, surplus: false }), ['ahead', 'earlyMonth']);
  assert.deepEqual(situationsFor({ status: 'critical', cycleElapsed: 0.5, surplus: false }), ['critical']);
});

test('relevantTips returns 3..5 unique tips, specific ones first', () => {
  const statuses: Situation[] = ['onTrack', 'ahead', 'critical', 'exhausted', 'unlimited', 'surplus'];
  for (const s of statuses) {
    for (let seed = 0; seed < 31; seed++) {
      const tips = relevantTips([s], seed);
      assert.ok(tips.length >= Math.min(3, TIPS.length) && tips.length <= 5, `${s}: ${tips.length}`);
      assert.equal(new Set(tips.map((t) => t.id)).size, tips.length);
      const specific = TIPS.filter((t) => t.when.includes(s));
      if (specific.length > 0) {
        assert.ok(tips[0].when.includes(s), `${s} seed ${seed}`);
      }
    }
  }
});

test('relevantTips is deterministic per seed and rotates over days', () => {
  assert.deepEqual(
    relevantTips(['ahead'], 4).map((t) => t.id),
    relevantTips(['ahead'], 4).map((t) => t.id),
  );
  const firsts = new Set(Array.from({ length: 31 }, (_, d) => relevantTips(['general'], d)[0].id));
  assert.ok(firsts.size > 1);
});

test('pickTip accepts a status or situations', () => {
  assert.ok(pickTip('critical', 2).id);
  assert.ok(pickTip(['surplus', 'onTrack'], 2).id);
  assert.ok(pickTip('ahead', -7.5).id);
});
