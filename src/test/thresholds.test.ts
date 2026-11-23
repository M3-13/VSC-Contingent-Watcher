import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleKey, newlyCrossedThreshold } from '../core/thresholds';

test('returns undefined when nothing crossed', () => {
  assert.equal(newlyCrossedThreshold(49.9, [50, 75, 90], []), undefined);
});

test('returns the highest newly crossed threshold', () => {
  assert.equal(newlyCrossedThreshold(80, [50, 75, 90], []), 75);
  assert.equal(newlyCrossedThreshold(95, [90, 50, 75], []), 90);
  assert.equal(newlyCrossedThreshold(50, [50], []), 50);
});

test('ignores already notified thresholds', () => {
  assert.equal(newlyCrossedThreshold(80, [50, 75, 90], [75]), 50);
  assert.equal(newlyCrossedThreshold(80, [50, 75, 90], [50, 75]), undefined);
});

test('handles duplicates and non-positive thresholds', () => {
  assert.equal(newlyCrossedThreshold(60, [50, 50, 50], []), 50);
  assert.equal(newlyCrossedThreshold(60, [0, -5], []), undefined);
  assert.equal(newlyCrossedThreshold(60, [], []), undefined);
});

test('cycleKey uses the date part of the reset', () => {
  assert.equal(cycleKey('2026-12-01T00:00:00.000Z'), '2026-12-01');
  assert.notEqual(cycleKey('2026-12-01T00:00:00.000Z'), cycleKey('2027-01-01T00:00:00.000Z'));
});
