import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIPS, pickTip } from '../core/tips';
import { PaceStatus } from '../core/types';

const STATUSES: PaceStatus[] = ['onTrack', 'ahead', 'critical', 'exhausted', 'unlimited'];

test('tip ids are unique', () => {
  assert.equal(new Set(TIPS.map((t) => t.id)).size, TIPS.length);
});

test('pickTip is deterministic per seed', () => {
  for (const s of STATUSES) {
    for (let seed = 0; seed < 20; seed++) {
      assert.equal(pickTip(s, seed).id, pickTip(s, seed).id);
    }
  }
});

test('pickTip returns a relevant tip', () => {
  for (const s of ['onTrack', 'ahead', 'critical', 'exhausted'] as PaceStatus[]) {
    for (let seed = 0; seed < 20; seed++) {
      assert.ok(pickTip(s, seed).when.includes(s), `${s} seed ${seed}`);
    }
  }
});

test('pickTip falls back to general tips when none match', () => {
  for (let seed = 0; seed < 20; seed++) {
    assert.equal(pickTip('unlimited', seed).when.length, 0);
  }
});

test('pickTip rotates with the seed and tolerates odd seeds', () => {
  const ids = new Set<string>();
  for (let seed = 0; seed < 20; seed++) ids.add(pickTip('ahead', seed).id);
  assert.ok(ids.size > 1);
  assert.ok(pickTip('ahead', -7).id);
  assert.ok(pickTip('ahead', 3.9).id);
});
