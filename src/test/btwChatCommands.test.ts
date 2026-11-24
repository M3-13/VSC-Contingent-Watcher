import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOpen } from '../chat/chatCommands';

const ALL = [
  'workbench.action.chat.open',
  'workbench.action.chat.newChat',
  'workbench.action.chat.openInEditor',
  'workbench.action.chat.openInNewWindow',
  'workbench.action.openChat',
  'workbench.action.newChatWindow',
];

test('window placement uses the new chat window command', () => {
  assert.deepEqual(planOpen(ALL, 'window'), { command: 'workbench.action.newChatWindow', kind: 'window' });
});

test('side and tab use the new chat editor command', () => {
  assert.deepEqual(planOpen(ALL, 'side'), { command: 'workbench.action.openChat', kind: 'editor' });
  assert.deepEqual(planOpen(ALL, 'tab'), { command: 'workbench.action.openChat', kind: 'editor' });
});

test('window falls back to a chat editor (moved later) when no chat window command exists', () => {
  const noWindow = ALL.filter((c) => c !== 'workbench.action.newChatWindow');
  assert.deepEqual(planOpen(noWindow, 'window'), { command: 'workbench.action.openChat', kind: 'editor' });
});

test('never picks commands that move or replace the current session', () => {
  const risky = ['workbench.action.chat.newChat', 'workbench.action.chat.openInEditor', 'workbench.action.chat.openInNewWindow', 'workbench.action.chat.open'];
  assert.equal(planOpen(risky, 'window'), undefined);
  assert.equal(planOpen(risky, 'tab'), undefined);
});
