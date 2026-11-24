import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipMiddle, parseChatSession, responseText, selectRecentTurns } from '../btw/chatSessionParse';

const req = (text: string, ...response: unknown[]) => ({ message: { text, parts: [{ text }] }, response });

test('JSON session with markdown parts, markdownContent, references and tool calls', () => {
  const session = {
    version: 3,
    requests: [
      req('How do I add a test?', { value: 'Use ' }, { kind: 'inlineReference', inlineReference: { path: '/w/src/test/a.test.ts' } }, { value: ' as a template.' }),
      req(
        'Now fix the build',
        { kind: 'toolInvocationSerialized', invocationMessage: { value: 'Running tsc' }, pastTenseMessage: { value: 'Ran tsc' } },
        { kind: 'thinking', value: 'secret chain of thought' },
        { kind: 'markdownContent', content: { value: 'Fixed the missing import.' } },
        { kind: 'textEditGroup', uri: { path: '/w/src/app.ts' }, edits: [] },
      ),
    ],
  };
  const snap = parseChatSession(JSON.stringify(session));
  assert.ok(snap);
  assert.equal(snap.turns.length, 2);
  assert.equal(snap.totalTurns, 2);
  assert.equal(snap.truncated, false);
  assert.deepEqual(snap.turns[0], { user: 'How do I add a test?', assistant: 'Use `a.test.ts` as a template.' });
  assert.match(snap.turns[1].assistant, /\[tool\] Ran tsc/);
  assert.match(snap.turns[1].assistant, /Fixed the missing import\./);
  assert.match(snap.turns[1].assistant, /\[edited app\.ts\]/);
  assert.doesNotMatch(snap.turns[1].assistant, /secret/);
});

test('message.parts fallback, string message and pending response', () => {
  const session = {
    requests: [
      { message: { parts: [{ text: 'Hello ' }, { text: 'there' }] }, response: [] },
      { message: 'plain string', response: { value: [{ value: 'ok' }] } },
    ],
  };
  const snap = parseChatSession(JSON.stringify(session));
  assert.deepEqual(snap?.turns, [
    { user: 'Hello there', assistant: '' },
    { user: 'plain string', assistant: 'ok' },
  ]);
});

test('skips our own participant by agent id and prefix', () => {
  const session = {
    requests: [
      req('real question', { value: 'real answer' }),
      { ...req('@sparsam /btw side', { value: 'x' }), agent: { id: 'contingentWatcher.sparsam' } },
      req('@sparsam what is 2+2', { value: '4' }),
    ],
  };
  const snap = parseChatSession(JSON.stringify(session), {
    skipAgentIds: ['contingentWatcher.sparsam'],
    skipPrefixes: ['@sparsam'],
  });
  assert.equal(snap?.turns.length, 1);
  assert.equal(snap?.turns[0].user, 'real question');
});

test('JSONL mutation log: snapshot, push, set, splice, delete', () => {
  const lines = [
    { kind: 0, v: { version: 3, sessionId: 's', requests: [] } },
    { kind: 2, k: ['requests'], v: [req('first', { value: 'draft' })] },
    { kind: 1, k: ['requests', 0, 'response'], v: [{ value: 'final answer 1' }] },
    { kind: 2, k: ['requests'], v: [req('second')] },
    { kind: 2, k: ['requests', 1, 'response'], v: [{ value: 'part A ' }] },
    { kind: 2, k: ['requests', 1, 'response'], v: [{ value: 'part B' }] },
    { kind: 2, k: ['requests', 1, 'response'], v: [{ value: 'replaced B' }], i: 1 },
    { kind: 2, k: ['requests'], v: [req('third', { value: 'gone' })] },
    { kind: 3, k: ['requests', 2] },
  ];
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const snap = parseChatSession(text);
  assert.deepEqual(snap?.turns, [
    { user: 'first', assistant: 'final answer 1' },
    { user: 'second', assistant: 'part A replaced B' },
  ]);
});

test('JSONL: garbage lines, partial last line, full-snapshot lines and bare requests', () => {
  const text = [
    'not json at all',
    JSON.stringify({ requests: [req('a', { value: 'A' })] }),
    '{"kind":1,"k":["__proto__","polluted"],"v":true}',
    '{"kind":1,"k":["requests",5,"response"],"v":[]}', // out of range: skipped
    '42',
    JSON.stringify(req('b', { value: 'B' })),
    '{"kind":2,"k":["requests"],"v":[{"message":{"text":"c"},"resp',
  ].join('\n');
  const snap = parseChatSession(text);
  assert.deepEqual(snap?.turns, [
    { user: 'a', assistant: 'A' },
    { user: 'b', assistant: 'B' },
  ]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('unusable input returns undefined and never throws', () => {
  for (const input of ['', '   ', 'garbage', '[]', '{}', 'null', '{"requests":[]}', '{"requests":[{"message":{"text":""}}]}', '\u0000\u0001', '{"kind":0,"v":5}']) {
    assert.equal(parseChatSession(input), undefined, JSON.stringify(input));
  }
  // Weird shapes inside requests are ignored.
  const snap = parseChatSession(JSON.stringify({ requests: [null, 3, 'x', { response: [null, 7, { kind: 'unknown' }] }, req('ok', 'str part')] }));
  assert.deepEqual(snap?.turns, [{ user: 'ok', assistant: 'str part' }]);
});

test('keeps only the newest turns', () => {
  const requests = Array.from({ length: 12 }, (_, i) => req(`q${i}`, { value: `a${i}` }));
  const snap = parseChatSession(JSON.stringify({ requests }), { maxTurns: 8 });
  assert.equal(snap?.turns.length, 8);
  assert.equal(snap?.totalTurns, 12);
  assert.equal(snap?.truncated, true);
  assert.equal(snap?.turns[0].user, 'q4');
  assert.equal(snap?.turns[7].user, 'q11');
});

test('character budget keeps the newest turns and shortens the oldest kept one', () => {
  const big = (c: string) => c.repeat(3000);
  const turns = [
    { user: 'old', assistant: big('o') },
    { user: 'mid', assistant: big('m') },
    { user: 'new', assistant: big('n') },
  ];
  const snap = selectRecentTurns(turns, { maxChars: 5000, maxCharsPerMessage: 4000 });
  assert.equal(snap.truncated, true);
  assert.equal(snap.turns.length, 2);
  assert.equal(snap.turns[1].user, 'new');
  assert.equal(snap.turns[1].assistant, big('n'));
  assert.equal(snap.turns[0].user, 'mid');
  const total = snap.turns.reduce((n, t) => n + t.user.length + t.assistant.length, 0);
  assert.ok(total <= 5000, `total ${total}`);
  assert.match(snap.turns[0].assistant, /shortened/);
});

test('per-message cap keeps head and tail', () => {
  const text = 'HEAD' + 'x'.repeat(10000) + 'TAIL';
  const clipped = clipMiddle(text, 1000);
  assert.ok(clipped.length <= 1000);
  assert.ok(clipped.startsWith('HEAD'));
  assert.ok(clipped.endsWith('TAIL'));
  assert.equal(clipMiddle('short', 100), 'short');
  assert.equal(clipMiddle('abc', 0), '');
});

test('default budget is about 12k characters', () => {
  const requests = Array.from({ length: 8 }, (_, i) => req(`q${i}`, { value: String(i).repeat(5000) }));
  const snap = parseChatSession(JSON.stringify({ requests }));
  assert.ok(snap);
  const total = snap.turns.reduce((n, t) => n + t.user.length + t.assistant.length, 0);
  assert.ok(total <= 12000, `total ${total}`);
  assert.equal(snap.turns[snap.turns.length - 1].user, 'q7');
});

test('responseText tolerates odd shapes', () => {
  assert.equal(responseText(undefined), '');
  assert.equal(responseText('direct'), 'direct');
  assert.equal(responseText({ value: 'v' }), 'v');
  assert.equal(responseText([{ kind: 'markdownVuln', content: { value: 'vuln md' } }]), 'vuln md');
  assert.equal(responseText([{ kind: 'toolInvocation', invocationMessage: 'Searching' }]), '[tool] Searching\n');
});
