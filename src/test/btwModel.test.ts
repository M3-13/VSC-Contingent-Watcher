import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSessionModel, parseChatSessionInfo } from '../btw/chatSessionParse';
import { btwModeOf, matchModel, stripVendor } from '../btw/modelMatch';

const req = (text: string, extra: Record<string, unknown> = {}) => ({ message: { text }, response: [{ value: 'ok' }], ...extra });

test('model of the newest request that names one (JSON)', () => {
  const session = {
    requests: [
      req('a', { modelId: 'copilot/gpt-4.1' }),
      req('b', { modelId: 'copilot/claude-sonnet-4.5' }),
      req('c'), // no model recorded
    ],
  };
  assert.equal(extractSessionModel(session), 'copilot/claude-sonnet-4.5');
  assert.equal(parseChatSessionInfo(JSON.stringify(session))?.modelId, 'copilot/claude-sonnet-4.5');
});

test('tolerates other field shapes', () => {
  assert.equal(extractSessionModel({ requests: [req('a', { selectedModel: { identifier: 'copilot/gpt-5' } })] }), 'copilot/gpt-5');
  assert.equal(extractSessionModel({ requests: [req('a', { agent: { id: 'x', modelId: 'o3' } })] }), 'o3');
  assert.equal(extractSessionModel({ requests: [req('a', { result: { metadata: { modelId: 'gemini-2.5-pro' } } })] }), 'gemini-2.5-pro');
  assert.equal(extractSessionModel({ requests: [req('a', { model: { metadata: { id: 'gpt-4o' } } })] }), 'gpt-4o');
  assert.equal(extractSessionModel({ requests: [req('a', { modelId: 42 }), req('b', { modelId: '  ' })] }), undefined);
  assert.equal(extractSessionModel({ requests: [] }), undefined);
});

test("input's selected model wins over older requests", () => {
  const session = {
    inputState: { selectedModel: { identifier: 'copilot/claude-opus-4.1', metadata: { family: 'claude-opus-4.1' } } },
    requests: [req('a', { modelId: 'copilot/gpt-4.1' })],
  };
  assert.equal(extractSessionModel(session), 'copilot/claude-opus-4.1');
});

test('JSONL: model set by a later patch; model without turns still reported', () => {
  const lines = [
    { kind: 0, v: { requests: [] } },
    { kind: 2, k: ['requests'], v: [req('a', { modelId: 'copilot/gpt-4.1' })] },
    { kind: 1, k: ['requests', 0, 'modelId'], v: 'copilot/gpt-5' },
  ];
  const info = parseChatSessionInfo(lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.equal(info?.modelId, 'copilot/gpt-5');
  assert.equal(info?.snapshot?.turns.length, 1);

  const onlyModel = parseChatSessionInfo(JSON.stringify({ inputState: { selectedModel: 'copilot/o3' }, requests: [] }));
  assert.equal(onlyModel?.modelId, 'copilot/o3');
  assert.equal(onlyModel?.snapshot, undefined);
});

const models = [
  { id: 'gpt-4.1', family: 'gpt-4.1', vendor: 'copilot', name: 'GPT-4.1' },
  { id: 'gpt-5', family: 'gpt-5', vendor: 'copilot', name: 'GPT-5' },
  { id: 'gpt-5-mini', family: 'gpt-5-mini', vendor: 'copilot', name: 'GPT-5 mini' },
  { id: 'claude-sonnet-4', family: 'claude-sonnet-4', vendor: 'copilot', name: 'Claude Sonnet 4' },
  { id: 'claude-sonnet-4.5', family: 'claude-sonnet-4.5', vendor: 'copilot', name: 'Claude Sonnet 4.5' },
  { id: 'gemini-2.5-pro-xyz', family: 'gemini-2.5-pro', vendor: 'copilot', name: 'Gemini 2.5 Pro' },
];

test('matches by id with or without vendor prefix, case-insensitive', () => {
  assert.equal(matchModel(models, 'copilot/claude-sonnet-4.5')?.id, 'claude-sonnet-4.5');
  assert.equal(matchModel(models, 'Claude-Sonnet-4.5')?.id, 'claude-sonnet-4.5');
  assert.equal(matchModel(models, 'copilot/gpt-5')?.id, 'gpt-5');
  assert.equal(stripVendor(' Copilot/GPT-5 '), 'gpt-5');
});

test('matches by family and display name', () => {
  assert.equal(matchModel(models, 'copilot/gemini-2.5-pro')?.id, 'gemini-2.5-pro-xyz');
  assert.equal(matchModel(models, 'GPT-5 mini')?.id, 'gpt-5-mini');
});

test('dated snapshots match their family, other variants do not', () => {
  assert.equal(matchModel(models, 'gpt-4.1-2025-04-14')?.id, 'gpt-4.1');
  assert.equal(matchModel(models, 'claude-sonnet-4.5-preview')?.id, 'claude-sonnet-4.5');
  // Never guess a different variant.
  assert.equal(matchModel(models, 'gpt-5-codex'), undefined);
  assert.equal(matchModel(models, 'claude-sonnet-4.7'), undefined);
  assert.equal(matchModel(models, 'gpt'), undefined);
  assert.equal(matchModel(models, 'auto'), undefined);
  assert.equal(matchModel(models, undefined), undefined);
  assert.equal(matchModel(models, ''), undefined);
  assert.equal(matchModel([], 'gpt-5'), undefined);
});

test('user-typed prefix only with allowPrefix (shortest family wins)', () => {
  assert.equal(matchModel(models, 'claude-sonnet'), undefined);
  assert.equal(matchModel(models, 'claude-sonnet', { allowPrefix: true })?.id, 'claude-sonnet-4');
  assert.equal(matchModel(models, 'gemini', { allowPrefix: true })?.id, 'gemini-2.5-pro-xyz');
  assert.equal(matchModel(models, 'llama', { allowPrefix: true }), undefined);
});

test('btwModeOf', () => {
  assert.equal(btwModeOf('chat'), 'chat');
  assert.equal(btwModeOf(' Included '), 'included');
  assert.equal(btwModeOf(''), 'chat');
  assert.equal(btwModeOf(undefined), 'chat');
  assert.equal(btwModeOf('gpt-5'), 'chat');
});
