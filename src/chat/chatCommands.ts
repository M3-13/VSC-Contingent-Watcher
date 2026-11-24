/**
 * Pure picking of the VS Code command that opens a *new* chat in an editor tab.
 * Command ids differ between VS Code versions, so known ids are tried first and
 * a pattern is used as a fallback. Commands that move or reopen the existing
 * session (open in editor / new window / sidebar …) are never chosen: the main
 * chat must stay untouched. No vscode import (unit-testable).
 */

/** Tried in this order. */
export const KNOWN_NEW_CHAT_EDITOR_COMMANDS: readonly string[] = [
  'workbench.action.chat.newEditor',
  'workbench.action.chat.openNewEditor',
  'workbench.action.chat.newChatEditor',
  'workbench.action.chat.newEditorChat',
  'workbench.action.openChatEditor',
];

const PATTERN = /^workbench\.action\.(?:chat\.)?(?:new|open)[A-Za-z]*Editor$/;
/** Commands that move/reopen the current session or are about something else. */
const EXCLUDE = /In(?:Editor|NewWindow|Sidebar|Panel|Window)|Move|Export|Import|Edits?Session|History|Inline|Terminal|Notebook|Quick/i;

export function isNewChatEditorCommand(id: string): boolean {
  const rest = id.replace(/^workbench\.action\.(?:chat\.)?/, '');
  // Must say "new": a bare "open…Editor" may reopen or move the current session.
  return PATTERN.test(id) && /new/i.test(rest) && !EXCLUDE.test(rest);
}

export function pickNewChatEditorCommand(available: Iterable<string>): string | undefined {
  const set = new Set(available);
  const known = KNOWN_NEW_CHAT_EDITOR_COMMANDS.find((id) => set.has(id));
  if (known) {
    return known;
  }
  // Prefer "new…" over "open…", then the shortest id; deterministic.
  return [...set]
    .filter(isNewChatEditorCommand)
    .sort((a, b) => Number(/\.(?:chat\.)?open/.test(a)) - Number(/\.(?:chat\.)?open/.test(b)) || a.length - b.length || a.localeCompare(b))[0];
}
