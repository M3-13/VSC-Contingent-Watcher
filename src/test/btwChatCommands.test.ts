import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewChatEditorCommand, pickNewChatEditorCommand } from '../chat/chatCommands';

const base = [
  'workbench.action.chat.open',
  'workbench.action.chat.openInEditor',
  'workbench.action.chat.openInNewWindow',
  'workbench.action.chat.openInSidebar',
  'workbench.action.chat.newChat',
  'workbench.action.quickchat.toggle',
  'editor.action.formatDocument',
];

test('known id wins, in order', () => {
  assert.equal(pickNewChatEditorCommand([...base, 'workbench.action.openChatEditor', 'workbench.action.chat.newEditor']), 'workbench.action.chat.newEditor');
  assert.equal(pickNewChatEditorCommand([...base, 'workbench.action.openChatEditor']), 'workbench.action.openChatEditor');
});

test('pattern fallback finds an unknown "new … Editor" command', () => {
  assert.equal(pickNewChatEditorCommand([...base, 'workbench.action.chat.newSessionEditor']), 'workbench.action.chat.newSessionEditor');
  assert.equal(
    pickNewChatEditorCommand([...base, 'workbench.action.chat.openNewSessionEditor', 'workbench.action.chat.newSessionEditor']),
    'workbench.action.chat.newSessionEditor',
  );
});

test('never picks commands that move or reopen the current session', () => {
  assert.equal(pickNewChatEditorCommand(base), undefined);
  assert.equal(pickNewChatEditorCommand([]), undefined);
  for (const id of [
    'workbench.action.chat.openInEditor',
    'workbench.action.chat.openInNewWindow',
    'workbench.action.chat.openEditor',
    'workbench.action.chat.openChatEditor',
    'workbench.action.chat.newInlineEditor',
    'workbench.action.chat.newEditSessionEditor',
    'workbench.action.chat.moveToNewEditor',
    'workbench.action.chat.newChat',
    'workbench.action.terminal.newEditor',
  ]) {
    assert.equal(isNewChatEditorCommand(id), false, id);
  }
  assert.equal(isNewChatEditorCommand('workbench.action.chat.newEditor'), true);
});
