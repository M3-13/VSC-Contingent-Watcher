/**
 * Best-effort parser for VS Code's locally persisted chat sessions
 * (`<workspaceStorage>/<hash>/chatSessions/*.json|*.jsonl`).
 *
 * The format is undocumented and changes between VS Code versions, so this
 * module is deliberately defensive: it never throws, skips anything it does not
 * understand and returns `undefined` when nothing usable is left.
 *
 * Supported shapes:
 * - JSON: `{ requests: [{ message: { text }, response: [...] }] }`
 * - JSONL mutation log: one object per line, `{ kind: 0, v: snapshot }`,
 *   `{ kind: 1, k: path, v }` (set), `{ kind: 2, k: path, v: items, i? }` (push /
 *   splice), `{ kind: 3, k: path }` (delete). Lines that are a whole session or a
 *   single request object are accepted too.
 *
 * Besides the conversation it extracts what the agent did (tool calls, terminal
 * commands, edited files), the session's title and its model.
 *
 * No vscode import: unit-testable with node:test.
 */

export interface ChatTurn {
  user: string;
  assistant: string;
}

export interface ChatSnapshot {
  /** Oldest first. */
  turns: ChatTurn[];
  /** Number of usable turns in the session (before keeping only the last ones). */
  totalTurns: number;
  /** True if turns were dropped or shortened. */
  truncated: boolean;
}

export interface ParseOptions {
  /** Keep at most this many of the newest turns (default 8). */
  maxTurns?: number;
  /** Total character budget for all kept turns (default 12000). */
  maxChars?: number;
  /** Upper bound for a single message (default 4000). */
  maxCharsPerMessage?: number;
  /** Requests handled by these chat participants are skipped. */
  skipAgentIds?: readonly string[];
  /** Requests whose text starts with one of these prefixes are skipped. */
  skipPrefixes?: readonly string[];
}

const DEFAULTS = { maxTurns: 8, maxChars: 12000, maxCharsPerMessage: 4000 };
const MAX_TOOL_LINE = 200;
/** Below this many remaining characters an extra (shortened) turn is not worth it. */
const MIN_PARTIAL = 400;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A plain string or an IMarkdownString-like `{ value }`. */
function mdText(v: unknown): string | undefined {
  if (typeof v === 'string') {
    return v;
  }
  if (isObj(v)) {
    return str(v.value);
  }
  return undefined;
}

// ------------------------------------------------------------------ entry

export interface ChatSessionInfo {
  /** Recent turns, if the session has any usable ones. */
  snapshot?: ChatSnapshot;
  /** Model selected in the chat (e.g. "copilot/claude-sonnet-4.5"), if recorded. */
  modelId?: string;
  /** The session's title, or its first user prompt (shortened). */
  title?: string;
  /** Files the agent edited or created, most recent first (URI strings or paths, unique). */
  touchedFiles: string[];
}

/** Parses the text of a session file (JSON or JSONL) into recent turns. */
export function parseChatSession(text: string, opts: ParseOptions = {}): ChatSnapshot | undefined {
  return parseChatSessionInfo(text, opts)?.snapshot;
}

/** Parses a session file into recent turns and the chat's current model. Never throws. */
export function parseChatSessionInfo(text: string, opts: ParseOptions = {}): ChatSessionInfo | undefined {
  try {
    const session = parseSessionObject(text);
    if (!session) {
      return undefined;
    }
    const turns = extractTurns(session, opts);
    const info: ChatSessionInfo = {
      snapshot: turns.length ? selectRecentTurns(turns, opts) : undefined,
      modelId: extractSessionModel(session),
      title: sessionTitle(session, turns),
      touchedFiles: touchedFiles(session, opts),
    };
    return info.snapshot || info.modelId ? info : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ model

const MAX_MODEL_REF = 200;

/** A model reference: a string id or an object with `identifier` / `id` / `metadata.id`. */
function modelRef(v: unknown): string | undefined {
  let ref: string | undefined;
  if (typeof v === 'string') {
    ref = v;
  } else if (isObj(v)) {
    ref =
      str(v.identifier) ??
      str(v.id) ??
      str(v.modelId) ??
      (isObj(v.metadata) ? str(v.metadata.id) ?? str(v.metadata.family) : undefined);
  }
  ref = ref?.trim();
  return ref && ref.length <= MAX_MODEL_REF ? ref : undefined;
}

/**
 * The model currently selected in the chat: the input's selected model if the
 * session records it, else the model of the newest request that names one.
 */
export function extractSessionModel(session: Obj): string | undefined {
  const input = isObj(session.inputState) ? session.inputState : undefined;
  const fromSession =
    (input && (modelRef(input.selectedModel) ?? modelRef(input.model) ?? modelRef(input.modelId))) ??
    modelRef(session.selectedModel);
  if (fromSession) {
    return fromSession;
  }
  const requests = Array.isArray(session.requests) ? session.requests : [];
  for (let i = requests.length - 1; i >= 0; i--) {
    const r = requests[i];
    if (!isObj(r)) {
      continue;
    }
    const meta = isObj(r.result) && isObj(r.result.metadata) ? r.result.metadata : undefined;
    const ref =
      modelRef(r.modelId) ??
      modelRef(r.selectedModel) ??
      modelRef(r.model) ??
      (isObj(r.agent) ? modelRef(r.agent.modelId) : undefined) ??
      (meta ? modelRef(meta.modelId) ?? modelRef(meta.model) : undefined);
    if (ref) {
      return ref;
    }
  }
  return undefined;
}

/** Returns the session object (something with a `requests` array) or undefined. */
export function parseSessionObject(text: string): Obj | undefined {
  if (typeof text !== 'string' || !text.trim()) {
    return undefined;
  }
  const trimmed = text.replace(/^﻿/, '').trim();
  let whole: unknown;
  let parsedWhole = false;
  try {
    whole = JSON.parse(trimmed);
    parsedWhole = true;
  } catch {
    // Not a single JSON document: treat as JSONL below.
  }
  if (parsedWhole) {
    if (isObj(whole) && Array.isArray(whole.requests)) {
      return whole;
    }
    // A one-line JSONL log parses as a single JSON value too.
    const fromLog = applyLog([whole]);
    return fromLog;
  }
  const lines: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) {
      continue;
    }
    try {
      lines.push(JSON.parse(l));
    } catch {
      // Garbage or a partially written last line: skip.
    }
  }
  return applyLog(lines);
}

// ------------------------------------------------------------------ JSONL mutation log

type Path = (string | number)[];

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validPath(k: unknown): k is Path {
  return (
    Array.isArray(k) &&
    k.every(
      (s) => (typeof s === 'string' && !FORBIDDEN_KEYS.has(s)) || (typeof s === 'number' && Number.isInteger(s) && s >= 0),
    )
  );
}

function looksLikeRequest(v: unknown): v is Obj {
  return isObj(v) && ('message' in v || 'response' in v) && !('kind' in v && 'k' in v);
}

function applyLog(entries: unknown[]): Obj | undefined {
  let root: unknown = undefined;
  for (const e of entries) {
    try {
      root = applyEntry(root, e);
    } catch {
      // Skip entries that do not fit the current state.
    }
  }
  return isObj(root) && Array.isArray(root.requests) ? root : undefined;
}

function applyEntry(root: unknown, e: unknown): unknown {
  if (!isObj(e)) {
    return root;
  }
  // A full session snapshot on one line.
  if (Array.isArray(e.requests) && !('kind' in e && 'v' in e)) {
    return e;
  }
  const kind = e.kind;
  if (kind === 0 && 'v' in e) {
    return isObj(e.v) ? e.v : root;
  }
  if (kind === 1 && validPath(e.k) && 'v' in e) {
    if (e.k.length === 0) {
      return e.v;
    }
    const parent = walk(root, e.k.slice(0, -1), true);
    setKey(parent, e.k[e.k.length - 1], e.v);
    return root;
  }
  if (kind === 2 && validPath(e.k) && Array.isArray(e.v)) {
    let arr = walk(root, e.k, false);
    if (!Array.isArray(arr)) {
      if (e.k.length === 0) {
        return root;
      }
      const parent = walk(root, e.k.slice(0, -1), true);
      arr = [];
      setKey(parent, e.k[e.k.length - 1], arr);
    }
    const a = arr as unknown[];
    if (typeof e.i === 'number' && Number.isInteger(e.i) && e.i >= 0 && e.i <= a.length) {
      a.length = e.i;
    }
    a.push(...e.v);
    return root;
  }
  if (kind === 3 && validPath(e.k) && e.k.length > 0) {
    const parent = walk(root, e.k.slice(0, -1), false);
    const key = e.k[e.k.length - 1];
    if (Array.isArray(parent) && typeof key === 'number') {
      parent.splice(key, 1);
    } else if (isObj(parent) && typeof key === 'string') {
      delete parent[key];
    }
    return root;
  }
  // A bare request object appended as a line.
  if (looksLikeRequest(e) && isObj(root) && Array.isArray(root.requests)) {
    root.requests.push(e);
    return root;
  }
  return root;
}

/** Walks `path` from `root`; with `create`, missing containers are created. Throws if impossible. */
function walk(root: unknown, path: Path, create: boolean): unknown {
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    let next: unknown;
    if (Array.isArray(cur) && typeof key === 'number') {
      next = cur[key];
    } else if (isObj(cur) && typeof key === 'string') {
      next = Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : undefined;
    } else {
      throw new Error('bad path');
    }
    if (next === undefined || next === null) {
      if (!create) {
        return undefined;
      }
      next = typeof path[i + 1] === 'number' ? [] : {};
      setKey(cur, key, next);
    }
    cur = next;
  }
  return cur;
}

function setKey(container: unknown, key: string | number, value: unknown): void {
  if (Array.isArray(container) && typeof key === 'number') {
    if (key > container.length) {
      throw new Error('sparse');
    }
    container[key] = value;
  } else if (isObj(container) && typeof key === 'string') {
    container[key] = value;
  } else {
    throw new Error('bad container');
  }
}

// ------------------------------------------------------------------ turns

export function extractTurns(session: Obj, opts: ParseOptions = {}): ChatTurn[] {
  const requests = Array.isArray(session.requests) ? session.requests : [];
  const skipAgents = new Set(opts.skipAgentIds ?? []);
  const skipPrefixes = (opts.skipPrefixes ?? []).map((p) => p.toLowerCase());
  const out: ChatTurn[] = [];
  for (const r of requests) {
    if (!isObj(r)) {
      continue;
    }
    const agentId = isObj(r.agent) ? str(r.agent.id) : undefined;
    if (agentId && skipAgents.has(agentId)) {
      continue;
    }
    const user = requestText(r).trim();
    if (user && skipPrefixes.some((p) => user.toLowerCase().startsWith(p))) {
      continue;
    }
    const assistant = analyzeResponse(r.response).text.trim();
    if (!user && !assistant) {
      continue;
    }
    out.push({ user, assistant });
  }
  return out;
}

export function requestText(r: Obj): string {
  const m = r.message;
  if (typeof m === 'string') {
    return m;
  }
  if (isObj(m)) {
    const t = str(m.text);
    if (t) {
      return t;
    }
    if (Array.isArray(m.parts)) {
      return m.parts.map((p) => (isObj(p) ? str(p.text) ?? '' : '')).join('');
    }
  }
  return str(r.prompt) ?? '';
}

export function responseText(resp: unknown): string {
  return analyzeResponse(resp).text;
}

/** What one response says and does: its text (with agent actions as lines) and the files it edited. */
export interface ResponseAnalysis {
  text: string;
  /** Edited/created files in order of appearance (URI strings or paths). */
  edited: string[];
}

function responseParts(resp: unknown): unknown[] | string {
  if (Array.isArray(resp)) {
    return resp;
  }
  if (isObj(resp)) {
    if (Array.isArray(resp.value)) {
      return resp.value;
    }
    if (Array.isArray(resp.parts)) {
      return resp.parts;
    }
    if (typeof resp.value === 'string') {
      return resp.value;
    }
  }
  return typeof resp === 'string' ? resp : [];
}

const EDIT_TOOL = /edit|create|replace|insert|write|apply|patch/i;
const TERMINAL_TOOL = /terminal|shell|run_?command|runInTerminal/i;

export function analyzeResponse(resp: unknown): ResponseAnalysis {
  const parts = responseParts(resp);
  if (typeof parts === 'string') {
    return { text: parts, edited: [] };
  }
  let text = '';
  const edited: string[] = [];
  const addEdited = (ref: string | undefined) => {
    if (ref && !edited.includes(ref)) {
      edited.push(ref);
    }
  };
  const push = (s: string, block = false) => {
    if (!s) {
      return;
    }
    if (block && text && !text.endsWith('\n')) {
      text += '\n';
    }
    text += s;
    if (block) {
      text += '\n';
    }
  };
  for (const p of parts) {
    if (typeof p === 'string') {
      push(p);
      continue;
    }
    if (!isObj(p)) {
      continue;
    }
    const kind = str(p.kind);
    if (!kind || kind === 'markdownContent' || kind === 'markdownVuln') {
      const v = kind ? mdText(p.content) : str(p.value);
      if (v) {
        push(v);
      }
      continue;
    }
    switch (kind) {
      case 'inlineReference': {
        const name = str(p.name) ?? refName(p.inlineReference);
        if (name) {
          push('`' + name + '`');
        }
        break;
      }
      case 'toolInvocation':
      case 'toolInvocationSerialized': {
        const toolId = str(p.toolId) ?? '';
        const data = isObj(p.toolSpecificData) ? p.toolSpecificData : undefined;
        const command = data ? terminalCommand(data) : undefined;
        const msg = mdText(p.pastTenseMessage) ?? mdText(p.invocationMessage);
        if (command || (data && str(data.kind) === 'terminal') || TERMINAL_TOOL.test(toolId)) {
          push('[ran] ' + oneLine(command ?? plainLinks(msg ?? toolId), MAX_TOOL_LINE), true);
        } else if (msg || toolId) {
          push('[tool] ' + oneLine(plainLinks(msg ?? toolId), MAX_TOOL_LINE), true);
        }
        if (EDIT_TOOL.test(toolId)) {
          for (const ref of [...uriRefs(p.resultDetails), ...uriRefs(data), ...fileLinks(msg)]) {
            addEdited(ref);
          }
        }
        break;
      }
      case 'textEditGroup':
      case 'codeblockUri': {
        const ref = uriRef(p.uri);
        if (ref) {
          addEdited(ref);
          if (kind === 'textEditGroup') {
            push('[edited ' + baseName(ref) + ']', true);
          }
        }
        break;
      }
      default:
        // thinking, warning, progressMessage, confirmation, undoStop, … : not conversation content.
        break;
    }
  }
  return { text, edited };
}

/** The command line of a terminal tool call, if recorded. */
function terminalCommand(data: Obj): string | undefined {
  const cl = data.commandLine;
  if (isObj(cl)) {
    return str(cl.userEdited) ?? str(cl.toolEdited) ?? str(cl.original);
  }
  return str(cl) ?? str(data.command);
}

/** "[label](file:///x)" → "label" (or the file name) so tool lines stay readable. */
function plainLinks(s: string): string {
  return s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => label || baseName(url));
}

function fileLinks(s: string | undefined): string[] {
  return s ? [...s.matchAll(/\]\((file:\/\/[^)\s]+)\)/g)].map((m) => m[1]) : [];
}

/** A serialized URI ({ external | fsPath | path }) or a URI string. */
function uriRef(v: unknown): string | undefined {
  if (typeof v === 'string') {
    return /^[a-z][\w+.-]*:\/\//i.test(v) || v.startsWith('/') ? v : undefined;
  }
  if (!isObj(v)) {
    return undefined;
  }
  if (isObj(v.uri)) {
    return uriRef(v.uri);
  }
  const scheme = str(v.scheme);
  return str(v.external) ?? str(v.fsPath) ?? (!scheme || scheme === 'file' ? str(v.path) : undefined);
}

function uriRefs(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(uriRef).filter((x): x is string => !!x);
  }
  const one = uriRef(v);
  return one ? [one] : [];
}

function baseName(ref: string): string {
  return decodeURIComponent(ref.replace(/[?#].*$/, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ref);
}

// ------------------------------------------------------------------ title and touched files

const MAX_TITLE = 60;

/** The session's custom title, else its first (non-skipped) user prompt, shortened to one line. */
export function sessionTitle(session: Obj, turns: readonly ChatTurn[]): string | undefined {
  const custom = str(session.customTitle) ?? str(session.title);
  const raw = custom?.trim() || turns.find((t) => t.user.trim())?.user;
  return raw ? oneLine(raw, MAX_TITLE) : undefined;
}

/** Files the agent edited, most recent request first; skipped (side-question) requests are ignored. */
export function touchedFiles(session: Obj, opts: ParseOptions = {}): string[] {
  const requests = Array.isArray(session.requests) ? session.requests : [];
  const skipPrefixes = (opts.skipPrefixes ?? []).map((p) => p.toLowerCase());
  const out: string[] = [];
  for (let i = requests.length - 1; i >= 0; i--) {
    const r = requests[i];
    if (!isObj(r) || skipPrefixes.some((p) => requestText(r).trim().toLowerCase().startsWith(p))) {
      continue;
    }
    const edited = analyzeResponse(r.response).edited;
    for (let j = edited.length - 1; j >= 0; j--) {
      if (!out.includes(edited[j])) {
        out.push(edited[j]);
      }
    }
  }
  return out;
}

function refName(ref: unknown): string | undefined {
  if (!isObj(ref)) {
    return undefined;
  }
  const uri = isObj(ref.uri) ? ref.uri : ref;
  const p = str(uri.path) ?? str(uri.fsPath) ?? str(uri.external);
  if (!p) {
    return undefined;
  }
  const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return base || undefined;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

// ------------------------------------------------------------------ truncation

/** Shortens `text` to at most ~`max` characters, keeping its head and tail. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 0) {
    return '';
  }
  if (max <= 40) {
    return text.slice(0, Math.max(0, max - 1)) + '…';
  }
  const marker = '\n… [shortened] …\n';
  const keep = max - marker.length;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : '');
}

/** Keeps the newest turns within the turn and character budgets. */
export function selectRecentTurns(turns: readonly ChatTurn[], opts: ParseOptions = {}): ChatSnapshot {
  const maxTurns = Math.max(1, opts.maxTurns ?? DEFAULTS.maxTurns);
  const maxChars = Math.max(MIN_PARTIAL, opts.maxChars ?? DEFAULTS.maxChars);
  const perMsg = Math.max(100, opts.maxCharsPerMessage ?? DEFAULTS.maxCharsPerMessage);

  let truncated = turns.length > maxTurns;
  const recent = turns.slice(-maxTurns);
  const kept: ChatTurn[] = [];
  let remaining = maxChars;
  for (let i = recent.length - 1; i >= 0; i--) {
    let user = clipMiddle(recent[i].user, perMsg);
    let assistant = clipMiddle(recent[i].assistant, perMsg);
    if (user !== recent[i].user || assistant !== recent[i].assistant) {
      truncated = true;
    }
    const cost = user.length + assistant.length;
    if (cost <= remaining) {
      kept.unshift({ user, assistant });
      remaining -= cost;
      continue;
    }
    truncated = true;
    if (remaining >= MIN_PARTIAL) {
      const userBudget = Math.min(user.length, Math.floor(remaining * 0.4));
      user = clipMiddle(user, userBudget);
      assistant = clipMiddle(assistant, Math.max(0, remaining - user.length));
      kept.unshift({ user, assistant });
    }
    break;
  }
  return { turns: kept, totalTurns: turns.length, truncated };
}

// ------------------------------------------------------------------ working session

/**
 * True if the session holds the user's actual work: at least one usable turn
 * after skipping side-question (@btw) turns. An empty new chat tab or one with
 * only @btw turns is not a working session.
 */
export function isWorkingSession(info: ChatSessionInfo | undefined): boolean {
  return !!info?.snapshot && info.snapshot.turns.length > 0;
}

export interface SessionCandidate {
  name: string;
  /** Last modified, ms since epoch. */
  mtime: number;
  info?: ChatSessionInfo;
}

/** The most recently modified working session, or undefined. */
export function pickWorkingSession<T extends SessionCandidate>(candidates: readonly T[]): T | undefined {
  return [...candidates].sort((a, b) => b.mtime - a.mtime).find((c) => isWorkingSession(c.info));
}
