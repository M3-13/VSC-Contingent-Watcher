import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultResetDate, parseCopilotUser } from '../core/parse';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

test('parses a typical response', () => {
  const s = parseCopilotUser(
    {
      copilot_plan: 'individual',
      quota_reset_date: '2026-12-01',
      quota_snapshots: {
        chat: { unlimited: true },
        completions: { unlimited: true },
        premium_interactions: {
          entitlement: 300,
          remaining: 120,
          percent_remaining: 40,
          unlimited: false,
          overage_permitted: true,
          overage_count: 0,
        },
      },
    },
    NOW,
  );
  assert.ok(s);
  assert.equal(s.entitlement, 300);
  assert.equal(s.remaining, 120);
  assert.equal(s.used, 180);
  assert.equal(s.unlimited, false);
  assert.equal(s.overagePermitted, true);
  assert.equal(s.overageCount, 0);
  assert.equal(s.resetDate, '2026-12-01T00:00:00.000Z');
  assert.equal(s.unit, 'requests');
  assert.equal(s.quotaId, 'premium_interactions');
  assert.equal(s.plan, 'individual');
  assert.equal(s.fetchedAt, NOW);
});

test('derives remaining from percent_remaining only', () => {
  const s = parseCopilotUser(
    { quota_snapshots: { premium_interactions: { entitlement: 300, percent_remaining: 40 } } },
    NOW,
  );
  assert.ok(s);
  assert.equal(s.remaining, 120);
  assert.equal(s.used, 180);
});

test('clamps negative remaining to zero', () => {
  const s = parseCopilotUser(
    { quota_snapshots: { premium_interactions: { entitlement: 300, remaining: -25 } } },
    NOW,
  );
  assert.ok(s);
  assert.equal(s.remaining, 0);
  assert.equal(s.used, 300);
});

test('unknown key containing "credit" uses credits unit', () => {
  const s = parseCopilotUser(
    { quota_snapshots: { monthly_credit_pool: { entitlement: 1000, remaining: 900 } } },
    NOW,
  );
  assert.ok(s);
  assert.equal(s.unit, 'credits');
  assert.equal(s.quotaId, 'monthly_credit_pool');
  assert.equal(s.used, 100);
});

test('preferred key wins over other keys', () => {
  const s = parseCopilotUser(
    {
      quota_snapshots: {
        other: { entitlement: 5, remaining: 5 },
        premium_interactions: { entitlement: 300, remaining: 300 },
      },
    },
    NOW,
  );
  assert.equal(s?.quotaId, 'premium_interactions');
});

test('missing reset date falls back to 1st of next month UTC', () => {
  const s = parseCopilotUser({ quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 1 } } }, NOW);
  assert.equal(s?.resetDate, '2026-12-01T00:00:00.000Z');
  assert.equal(defaultResetDate(Date.UTC(2026, 11, 31, 23, 59)), '2027-01-01T00:00:00.000Z');
});

test('invalid reset date falls back to default; quota_reset_date_utc is preferred', () => {
  const bad = parseCopilotUser(
    { quota_reset_date: 'nonsense', quota_snapshots: { premium_interactions: { entitlement: 1, remaining: 1 } } },
    NOW,
  );
  assert.equal(bad?.resetDate, '2026-12-01T00:00:00.000Z');
  const utc = parseCopilotUser(
    {
      quota_reset_date_utc: '2027-02-01T00:00:00.000Z',
      quota_reset_date: '2026-12-01',
      quota_snapshots: { premium_interactions: { entitlement: 1, remaining: 1 } },
    },
    NOW,
  );
  assert.equal(utc?.resetDate, '2027-02-01T00:00:00.000Z');
});

test('garbage input returns undefined', () => {
  for (const input of [undefined, null, 'x', 42, {}, { quota_snapshots: {} }, { quota_snapshots: { chat: { unlimited: true } } }]) {
    assert.equal(parseCopilotUser(input, NOW), undefined);
  }
});

test('unlimited plan', () => {
  const s = parseCopilotUser(
    { copilot_plan: 'enterprise', quota_snapshots: { premium_interactions: { unlimited: true } } },
    NOW,
  );
  assert.ok(s);
  assert.equal(s.unlimited, true);
  assert.equal(s.used, 0);
  assert.equal(s.plan, 'enterprise');
});

test('accepts numeric strings', () => {
  const s = parseCopilotUser(
    { quota_snapshots: { premium_interactions: { entitlement: '300', remaining: '100' } } },
    NOW,
  );
  assert.equal(s?.used, 200);
});
