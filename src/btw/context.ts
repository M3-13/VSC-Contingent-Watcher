/**
 * Gathers the context for a btw side question: a snapshot of the most recent
 * local Copilot chat session (best effort) and of the active editor.
 * Never throws; missing parts are simply left out.
 */
import * as vscode from 'vscode';
import { parseChatSession } from './chatSessionParse';
import { BtwChatContext, BtwContext, ContextLabels, EditorDiagnostic, EditorSnapshot, describeContext } from './prompt';

export const SPARSAM_PARTICIPANT_ID = 'contingentWatcher.sparsam';

const CURSOR_RADIUS = 30;
const MAX_EDITOR_CHARS = 8000;
const MAX_LINE_CHARS = 400;
const MAX_DIAGNOSTICS = 20;
/** Session files larger than this are not read. */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
/** Sessions not written for longer than this are not "what you're doing now". */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
/** Try this many of the newest session files (a brand-new chat may still be empty). */
const SESSION_CANDIDATES = 3;

export interface GatherOptions {
  /** Defaults to the `contingentWatcher.btw.includeChat` setting. */
  includeChat?: boolean;
  includeEditor?: boolean;
  log?: (message: string) => void;
}

export async function gatherBtwContext(ext: vscode.ExtensionContext, opts: GatherOptions = {}): Promise<BtwContext> {
  const log = opts.log ?? (() => undefined);
  const includeChat =
    opts.includeChat ?? vscode.workspace.getConfiguration('contingentWatcher').get<boolean>('btw.includeChat', true) !== false;
  const ctx: BtwContext = {};
  if (includeChat) {
    try {
      ctx.chat = await readLatestChat(ext, log);
    } catch (err) {
      log(`btw: chat context unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
  } else {
    log('btw: chat context disabled by contingentWatcher.btw.includeChat');
  }
  if (opts.includeEditor !== false) {
    try {
      ctx.editor = editorSnapshot();
    } catch {
      // ignore
    }
  }
  return ctx;
}

/** Localised labels for {@link describeContext}. */
export function contextLabels(): ContextLabels {
  return {
    chatOne: vscode.l10n.t('chat (1 turn)'),
    chatMany: vscode.l10n.t('chat ({0} turns)', '{0}'),
    selection: vscode.l10n.t('editor selection in {0}', '{0}'),
    cursor: vscode.l10n.t('editor around line {0} in {1}', '{0}', '{1}'),
    problemOne: vscode.l10n.t('1 problem'),
    problemMany: vscode.l10n.t('{0} problems', '{0}'),
    referenceOne: vscode.l10n.t('1 reference'),
    referenceMany: vscode.l10n.t('{0} references', '{0}'),
    none: vscode.l10n.t('none'),
  };
}

export function describeBtwContext(ctx: BtwContext): string {
  return describeContext(ctx, contextLabels());
}

// ------------------------------------------------------------------ chat

/** Directories where VS Code persists chat sessions for this window. */
function sessionDirs(ext: vscode.ExtensionContext): vscode.Uri[] {
  if (ext.storageUri) {
    // <workspaceStorage>/<hash>/<extension id> → <workspaceStorage>/<hash>/chatSessions
    return [vscode.Uri.joinPath(ext.storageUri, '..', 'chatSessions')];
  }
  // Empty window: <globalStorage>/<extension id> → <globalStorage>/emptyWindowChatSessions
  return [vscode.Uri.joinPath(ext.globalStorageUri, '..', 'emptyWindowChatSessions')];
}

interface SessionFile {
  uri: vscode.Uri;
  name: string;
  mtime: number;
  size: number;
}

async function listSessionFiles(dir: vscode.Uri): Promise<SessionFile[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return [];
  }
  const names = entries
    .filter(([name, type]) => type === vscode.FileType.File && /\.jsonl?$/i.test(name))
    .map(([name]) => name)
    .slice(0, 500);
  const files = await Promise.all(
    names.map(async (name): Promise<SessionFile | undefined> => {
      const uri = vscode.Uri.joinPath(dir, name);
      try {
        const st = await vscode.workspace.fs.stat(uri);
        return { uri, name, mtime: st.mtime, size: st.size };
      } catch {
        return undefined;
      }
    }),
  );
  return files.filter((f): f is SessionFile => !!f).sort((a, b) => b.mtime - a.mtime);
}

async function readLatestChat(ext: vscode.ExtensionContext, log: (m: string) => void): Promise<BtwChatContext | undefined> {
  const files = (await Promise.all(sessionDirs(ext).map(listSessionFiles))).flat().sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) {
    log('btw: no local chat sessions found');
    return undefined;
  }
  const now = Date.now();
  for (const f of files.slice(0, SESSION_CANDIDATES)) {
    if (now - f.mtime > MAX_SESSION_AGE_MS) {
      log(`btw: newest chat session ${f.name} is older than 24 h, not used`);
      return undefined;
    }
    if (f.size > MAX_SESSION_BYTES) {
      log(`btw: chat session ${f.name} is too large (${Math.round(f.size / 1048576)} MB), skipped`);
      continue;
    }
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(f.uri)).toString('utf8');
    } catch {
      continue;
    }
    const snap = parseChatSession(text, { skipAgentIds: [SPARSAM_PARTICIPANT_ID], skipPrefixes: ['@sparsam'] });
    if (snap) {
      log(
        `btw: chat context from ${f.name}: ${snap.turns.length} of ${snap.totalTurns} turns` +
          (snap.truncated ? ' (shortened)' : ''),
      );
      return { ...snap, ageMinutes: Math.max(0, (now - f.mtime) / 60000) };
    }
    log(`btw: no usable turns in chat session ${f.name}`);
  }
  return undefined;
}

// ------------------------------------------------------------------ editor

const IGNORED_SCHEMES = new Set(['output', 'debug', 'vscode-settings', 'git', 'comment']);

function editorSnapshot(): EditorSnapshot | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || IGNORED_SCHEMES.has(ed.document.uri.scheme) || ed.document.uri.scheme.startsWith('vscode-chat')) {
    return undefined;
  }
  const doc = ed.document;
  const sel = ed.selection;
  let range: vscode.Range;
  let kind: EditorSnapshot['kind'];
  let text: string;
  if (!sel.isEmpty) {
    kind = 'selection';
    range = new vscode.Range(sel.start, sel.end);
    text = doc.getText(range);
  } else {
    kind = 'cursor';
    const c = sel.active.line;
    const start = Math.max(0, c - CURSOR_RADIUS);
    const end = Math.min(doc.lineCount - 1, c + CURSOR_RADIUS);
    range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    text = doc.getText(range);
    if (!text.trim()) {
      return undefined;
    }
  }
  text = text
    .split(/\r?\n/)
    .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + ' …' : l))
    .join('\n');
  if (text.length > MAX_EDITOR_CHARS) {
    text = text.slice(0, MAX_EDITOR_CHARS) + '\n… [shortened]';
  }

  const diagnostics: EditorDiagnostic[] = vscode.languages
    .getDiagnostics(doc.uri)
    .filter(
      (d) =>
        (d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning) &&
        d.range.start.line <= range.end.line &&
        d.range.end.line >= range.start.line,
    )
    .sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line)
    .slice(0, MAX_DIAGNOSTICS)
    .map((d) => ({
      line: d.range.start.line + 1,
      severity: d.severity === vscode.DiagnosticSeverity.Error ? ('error' as const) : ('warning' as const),
      message: d.message.length > 300 ? d.message.slice(0, 300) + '…' : d.message,
      source: d.source,
    }));

  return {
    path: doc.isUntitled ? doc.uri.path : vscode.workspace.asRelativePath(doc.uri, false),
    languageId: doc.languageId,
    kind,
    startLine: range.start.line + 1,
    endLine: range.end.line + 1,
    cursorLine: sel.active.line + 1,
    text,
    diagnostics,
  };
}

/** True if the active editor has a non-empty selection. */
export function hasEditorSelection(): boolean {
  const ed = vscode.window.activeTextEditor;
  return !!ed && !ed.selection.isEmpty;
}
