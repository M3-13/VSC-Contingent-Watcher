import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelUsage } from '../core/billing';
import { parseCopilotUser } from '../core/parse';

const body = {
  quota_reset_date: '2026-12-01',
  quota_snapshots: {
    chat: { unlimited: true },
    premium_interactions: { entitlement: 300, remaining: 100, unlimited: false },
    ai_credits: { entitlement: 3900, remaining: 2500, unlimited: false },
  },
};

test('auto prefers AI credits over premium requests', () => {
  const s = parseCopilotUser(body, Date.UTC(2026, 10, 20));
  assert.equal(s?.unit, 'credits');
  assert.equal(s?.entitlement, 3900);
  assert.equal(s?.used, 1400);
});

test('requests preference picks premium requests', () => {
  const s = parseCopilotUser(body, Date.UTC(2026, 10, 20), 'requests');
  assert.equal(s?.unit, 'requests');
  assert.equal(s?.entitlement, 300);
});

test('falls back to requests when no credit quota exists', () => {
  const s = parseCopilotUser({ quota_snapshots: { premium_interactions: { entitlement: 50, remaining: 10 } } }, 0, 'credits');
  assert.equal(s?.unit, 'requests');
});

test('billing report yields credits per model and shares by cost', () => {
  const res = parseModelUsage({
    usageItems: [
      { model: 'Opus', grossQuantity: 10, grossAmount: 4.0 },
      { model: 'Sonnet', grossQuantity: 40, grossAmount: 1.6 },
      { model: 'Opus', grossQuantity: 5, grossAmount: 2.0 },
    ],
  });
  assert.equal(res[0].model, 'Opus');
  assert.equal(res[0].credits, 600);
  assert.equal(res[1].credits, 160);
  assert.ok(Math.abs(res[0].share - 6 / 7.6) < 1e-9);
});
