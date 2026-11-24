import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel, availableFamilies, matchesFamily, truncate } from '../chat/modelChoice';

const m = (family: string) => ({ family });

test('picks first preferred in order', () => {
  const r = chooseModel([m('gpt-4o'), m('gpt-4.1'), m('claude-sonnet')], ['gpt-5-mini', 'gpt-4.1', 'gpt-4o']);
  assert.equal(r?.family, 'gpt-4.1');
});

test('case-insensitive and prefix match', () => {
  assert.equal(chooseModel([m('GPT-5-mini-2026-01')], ['gpt-5-mini'])?.family, 'GPT-5-mini-2026-01');
  assert.equal(matchesFamily('gpt-4o', 'GPT-4O'), true);
});

test('exact beats prefix', () => {
  const r = chooseModel([m('gpt-4o-mini'), m('gpt-4o')], ['gpt-4o']);
  assert.equal(r?.family, 'gpt-4o');
});

test('no fallback when nothing matches', () => {
  assert.equal(chooseModel([m('claude-opus')], ['gpt-4o']), undefined);
  assert.equal(chooseModel([], ['gpt-4o']), undefined);
  assert.equal(chooseModel([m('gpt-4o')], []), undefined);
  assert.equal(chooseModel([m('gpt-4o')], ['', '  ']), undefined);
});

test('availableFamilies dedupes and sorts', () => {
  assert.deepEqual(availableFamilies([m('b'), m('a'), m('b')]), ['a', 'b']);
});

test('truncate', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.ok(truncate('abcdef', 3).startsWith('abc'));
});
