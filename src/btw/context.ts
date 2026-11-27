/**
 * Gathers the context for a btw side question, all read-only and local:
 * - the working Copilot chat session (newest session with real, non-btw turns),
 *   read from VS Code's chat storage: recent turns incl. agent actions, title, model;
 * - uncommitted git changes (built-in git extension);
 * - contents of the files the agent touched most recently;
 * - the active editor (selection or lines around the cursor) and its problems.
 * Never throws; missing parts are left out. Logs contain no content.
 */
import * as vscode from 'vscode';
import { ChatSessionInfo, isWorkingSession, parseChatSessionInfo } from './chatSessionParse';
import { BtwContext, EditorDiagnostic, EditorSnapshot, FileContent, GitChange, GitContext, SessionContext } from './prompt';
import { hunkStart } from './gitText';

const CURSOR_RADIUS = 30;
const MAX_EDITOR_CHARS = 8000;
const MAX_LINE_CHARS = 400;
const MAX_DIAGNOSTICS = 20;
/** Session files larger than this are not read. */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
/** Sessions not written for longer than this are not "what you're doing now". */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
/** Read at most this many of the newest session files when looking for the working session. */
const SESSION_CANDIDATES = 8;
/** /btw (prompt file) turns are side questions, not part of the main conversation. */
const SKIP = { skipPrefixes: ['/btw'], maxTurns: 8, maxChars: 16000, maxCharsPerMessage: 5000 };
const MAX_DIFF_FILES = 12;
const MAX_DIFF_CHARS = 6000;
const TOUCHED_FILES = 3;
const FILE_LINES = 150;
const MAX_FILE_CHARS = 7000;

export interface GatherOptions {
  /** Defaults to the `contingentWatcher.btw.includeChat` setting. */
  includeChat?: boolean;
  log?: (message: string) => void;
}

export interface SessionHeader {
  title?: string;
  modelId?: string;
}

/** Title and model of the working session (cheap; for the window header). */
export async function readSessionHeader(ext: vscode.ExtensionContext, log: (m: string) => void = () => undefined): Promise<SessionHeader> {
  try {
    const found = await findWorkingSession(ext, log);
    return { title: found?.info.title, modelId: found?.info.modelId };
  } catch {
    return {};
  }
}

export async function gatherBtwContext(
  ext: vscode.ExtensionContext,
  opts: GatherOptions = {},
): Promise<{ ctx: BtwContext; modelId?: string }> {
  const log = opts.log ?? (() => undefined);
  const includeChat =
    opts.includeChat ?? vscode.workspace.getConfiguration('contingentWatcher').get<boolean>('btw.includeChat', true) !== false;
  const ctx: BtwContext = { files: [] };
  let modelId: string | undefined;
  let touched: string[] = [];
  try {
    const found = await findWorkingSession(ext, log);
    if (found) {
      modelId = found.info.modelId;
      touched = found.info.touchedFiles;
      const snap = found.info.snapshot;
      if (includeChat && snap) {
        ctx.session = {
          title: found.info.title,
          modelId,
          turns: snap.turns,
          totalTurns: snap.totalTurns,
          ageMinutes: Math.max(0, (Date.now() - found.file.mtime) / 60000),
        } satisfies SessionContext;
      }
    }
  } catch (err) {
    log(`btw: chat session unavailable (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!includeChat) {
    log('btw: chat content not used (contingentWatcher.btw.includeChat is off)');
    touched = [];
  }
  try {
    ctx.git = await gitContext(touched, log);
  } catch (err) {
    log(`btw: git changes unavailable (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    ctx.files = await touchedFileContents(touched, ctx.git);
  } catch {
    // ignore
  }
  try {
    ctx.editor = editorSnapshot();
  } catch {
    // ignore
  }
  log(
    `btw: context: ${ctx.session?.turns.length ?? 0} turns, ${ctx.git?.changes.length ?? 0} changed files, ` +
      `${ctx.files.length} touched files, editor ${ctx.editor ? ctx.editor.kind : 'none'}`,
  );
  return { ctx, modelId };
}

// ------------------------------------------------------------------ chat session

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

/**
 * Finds the working session: the chat @btw was typed in, i.e. the most recently
 * modified session file with turns other than @btw side questions, and returns
 * its recent turns and model.
 */
async function findWorkingSession(
  ext: vscode.ExtensionContext,
  log: (m: string) => void,
): Promise<{ file: SessionFile; info: ChatSessionInfo } | undefined> {
  const files = (await Promise.all(sessionDirs(ext).map(listSessionFiles))).flat().sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) {
    log('btw: no local chat sessions found');
    return undefined;
  }
  const now = Date.now();
  for (const f of files.slice(0, SESSION_CANDIDATES)) {
    if (now - f.mtime > MAX_SESSION_AGE_MS) {
      log(`btw: chat session ${f.name} is older than 24 h, not used`);
      break;
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
    const info = parseChatSessionInfo(text, SKIP);
    if (info && isWorkingSession(info)) {
      log(
        `btw: working chat session ${f.name}: ${info.snapshot?.turns.length} of ${info.snapshot?.totalTurns} turns, ` +
          `${info.touchedFiles.length} touched files${info.modelId ? `, model ${info.modelId}` : ''}`,
      );
      return { file: f, info };
    }
  }
  log('btw: no working chat session found');
  return undefined;
}

// ------------------------------------------------------------------ git

const GIT_STATUS: Record<number, string> = {
  0: 'modified (staged)',
  1: 'added (staged)',
  2: 'deleted (staged)',
  3: 'renamed (staged)',
  4: 'copied (staged)',
  5: 'modified',
  6: 'deleted',
  7: 'untracked',
  9: 'added',
  10: 'type changed',
};

interface GitRawChange {
  uri: vscode.Uri;
  status: number;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string };
    indexChanges: GitRawChange[];
    workingTreeChanges: GitRawChange[];
    untrackedChanges?: GitRawChange[];
  };
  diffWithHEAD(path: string): Promise<string>;
}
interface GitApi {
  repositories: GitRepository[];
}

async function gitApi(): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<{ enabled?: boolean; getAPI(v: 1): GitApi }>('vscode.git');
  if (!ext) {
    return undefined;
  }
  const exp = ext.isActive ? ext.exports : await ext.activate();
  return exp && exp.enabled !== false ? exp.getAPI(1) : undefined;
}

function contains(root: vscode.Uri, uri: vscode.Uri): boolean {
  const r = root.fsPath.replace(/[\\/]+$/, '');
  return uri.fsPath === r || uri.fsPath.startsWith(r + '/') || uri.fsPath.startsWith(r + '\\');
}

async function gitContext(touched: string[], log: (m: string) => void): Promise<GitContext | undefined> {
  const api = await gitApi();
  const repos = api?.repositories ?? [];
  if (!repos.length) {
    return undefined;
  }
  const hint = vscode.window.activeTextEditor?.document.uri ?? (touched[0] ? toUri(touched[0]) : undefined);
  const repo = (hint && repos.find((r) => contains(r.rootUri, hint))) || repos[0];
  const all = [...repo.state.indexChanges, ...repo.state.workingTreeChanges, ...(repo.state.untrackedChanges ?? [])];
  const seen = new Map<string, GitRawChange>();
  for (const c of all) {
    if (!seen.has(c.uri.fsPath)) {
      seen.set(c.uri.fsPath, c);
    }
  }
  const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u, false);
  const changes: GitChange[] = [...seen.values()].map((c) => ({ path: rel(c.uri), status: GIT_STATUS[c.status] ?? 'changed' }));
  // Diffs: files the agent touched first, then the rest.
  const touchedSet = new Set(touched.map((t) => toUri(t)?.fsPath).filter(Boolean));
  const ordered = [...seen.values()].sort((a, b) => Number(touchedSet.has(b.uri.fsPath)) - Number(touchedSet.has(a.uri.fsPath)));
  const diffs: { path: string; diff: string }[] = [];
  for (const c of ordered.slice(0, MAX_DIFF_FILES)) {
    try {
      let diff: string;
      if (c.status === 7) {
        const text = Buffer.from(await vscode.workspace.fs.readFile(c.uri)).toString('utf8');
        diff = '(new, untracked file)\n' + text.split(/\r?\n/).slice(0, 80).map((l) => '+' + l).join('\n');
      } else {
        diff = await repo.diffWithHEAD(c.uri.fsPath);
      }
      if (diff.trim()) {
        diffs.push({ path: rel(c.uri), diff: diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + '\n… [diff shortened]' : diff });
      }
    } catch {
      // binary, deleted or unreadable: listed in `changes` only
    }
  }
  log(`btw: git: ${changes.length} changed files, ${diffs.length} diffs`);
  return { branch: repo.state.HEAD?.name, changes, diffs };
}

// ------------------------------------------------------------------ touched files

function toUri(ref: string): vscode.Uri | undefined {
  try {
    return /^[a-z][\w+.-]*:\/\//i.test(ref) ? vscode.Uri.parse(ref) : vscode.Uri.file(ref);
  } catch {
    return undefined;
  }
}

async function touchedFileContents(touched: string[], git: GitContext | undefined): Promise<FileContent[]> {
  const out: FileContent[] = [];
  for (const ref of touched) {
    if (out.length >= TOUCHED_FILES) {
      break;
    }
    const uri = toUri(ref);
    if (!uri) {
      continue;
    }
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      continue; // deleted or not accessible
    }
    if (text.includes('\u0000')) {
      continue; // binary
    }
    const path = vscode.workspace.asRelativePath(uri, false);
    const lines = text.split(/\r?\n/);
    // Around the first changed hunk if the file has a diff, else from the top.
    const diff = git?.diffs.find((d) => d.path === path)?.diff;
    const hunk = diff ? hunkStart(diff) : undefined;
    const start = hunk ? Math.max(1, hunk - 20) : 1;
    let body = lines
      .slice(start - 1, start - 1 + FILE_LINES)
      .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + ' …' : l))
      .join('\n');
    if (body.length > MAX_FILE_CHARS) {
      body = body.slice(0, MAX_FILE_CHARS) + '\n… [shortened]';
    }
    const languageId = (vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.languageId) ?? extLanguage(path);
    out.push({ path, languageId, startLine: start, text: body });
  }
  return out;
}

function extLanguage(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python', md: 'markdown', json: 'json', css: 'css', html: 'html', java: 'java', go: 'go', rs: 'rust', cs: 'csharp', rb: 'ruby', php: 'php', sh: 'bash', yml: 'yaml', yaml: 'yaml' };
  return map[ext] ?? ext;
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
