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
    const assistant = responseText(r.response).trim();
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
  let parts: unknown[] = [];
  if (Array.isArray(resp)) {
    parts = resp;
  } else if (isObj(resp)) {
    if (Array.isArray(resp.value)) {
      parts = resp.value;
    } else if (Array.isArray(resp.parts)) {
      parts = resp.parts;
    } else if (typeof resp.value === 'string') {
      return resp.value;
    }
  } else if (typeof resp === 'string') {
    return resp;
  }

  let text = '';
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
        const msg = mdText(p.pastTenseMessage) ?? mdText(p.invocationMessage);
        if (msg) {
          push('[tool] ' + oneLine(msg, MAX_TOOL_LINE), true);
        }
        break;
      }
      case 'textEditGroup': {
        const name = refName(p.uri);
        if (name) {
          push('[edited ' + name + ']', true);
        }
        break;
      }
      case 'warning':
      case 'progressMessage': {
        // Transient/status output: not useful as conversation context.
        break;
      }
      default:
        // thinking, codeblockUri, confirmation, … : skip.
        break;
    }
  }
  return text;
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
