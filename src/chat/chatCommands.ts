/**
 * Picks the VS Code command that opens a *new, separate* chat for btw.
 * Only explicit, known command ids are used: commands that move or replace the
 * current session must never run (the main chat has to stay untouched).
 * No vscode import (unit-testable).
 */

/** "Chat: New Chat Window": a new chat in its own window. */
export const NEW_CHAT_WINDOW_COMMANDS: readonly string[] = ['workbench.action.newChatWindow', 'workbench.action.chat.newChatWindow'];

/** "Chat: New Chat Editor": a new chat in an editor tab. */
export const NEW_CHAT_EDITOR_COMMANDS: readonly string[] = [
  'workbench.action.openChat',
  'workbench.action.chat.newChatEditor',
  'workbench.action.chat.newEditor',
];

export type OpenIn = 'window' | 'side' | 'tab';

export interface OpenPlan {
  /** Command that creates the new chat. */
  command: string;
  /** Where it ends up; 'window' commands need no extra move. */
  kind: 'window' | 'editor';
}

/**
 * The command to run for the wanted placement. A chat window is preferred for
 * 'window'; if the VS Code version has none, a chat editor tab is used and the
 * caller moves it into a new window.
 */
export function planOpen(available: Iterable<string>, openIn: OpenIn): OpenPlan | undefined {
  const set = new Set(available);
  const window = NEW_CHAT_WINDOW_COMMANDS.find((id) => set.has(id));
  const editor = NEW_CHAT_EDITOR_COMMANDS.find((id) => set.has(id));
  if (openIn === 'window' && window) {
    return { command: window, kind: 'window' };
  }
  if (editor) {
    return { command: editor, kind: 'editor' };
  }
  return window ? { command: window, kind: 'window' } : undefined;
}
