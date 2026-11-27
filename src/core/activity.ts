/**
 * Pure bookkeeping for "what did I work on and how long did it take".
 *
 * Model: per repo+branch there is an *open* unit that collects active editor
 * time and allowance usage. A unit ends with the user's own commit (on any
 * branch, including main/master) or, for manually started tasks, when the
 * task is finished. Finished units are stored; for display, units with the
 * same ticket id are grouped into one item.
 */

export interface ActivityKey {
  /** Repository folder name (or workspace name without git). */
  repo: string;
  /** Branch name, undefined without git. */
  branch?: string;
}

/** A finished piece of work. */
export interface WorkUnit {
  id: string;
  kind: 'commit' | 'manual' | 'legacy';
  repo: string;
  branch?: string;
  /** Commit message (truncated), manual task name, or the old last-commit detail. */
  message?: string;
  /** Commit hash ('commit' units). */
  hash?: string;
  /** Local date (YYYY-MM-DD) of old per-day items ('legacy' units). */
  day?: string;
  start: number;
  end: number;
  activeMs: number;
  used: number;
  commits: number;
}

/** Work not yet committed (one per repo+branch). */
export interface OpenUnit {
  repo: string;
  branch?: string;
  start: number;
  /** Last activity. */
  end: number;
  activeMs: number;
  used: number;
}

/** A manually started task: while it runs, all time and usage go to it. */
export interface ManualTask {
  name: string;
  repo?: string;
  branch?: string;
  start: number;
  end: number;
  activeMs: number;
  used: number;
}

export interface ActivityState {
  version: 2;
  /** Finished units, newest first. */
  units: WorkUnit[];
  open: OpenUnit[];
  manual?: ManualTask;
  /** Last seen HEAD commit per repository root, to detect new commits across restarts. */
  heads: Record<string, string>;
}

export interface CommitInfo {
  hash: string;
  message: string;
  parents: string[];
  authorEmail?: string;
  /** Epoch ms (commit date, else author date). */
  time?: number;
}

export const MAX_UNITS = 300;
export const MAX_OPEN = 30;
/** Max length of a stored commit message. */
const MAX_MESSAGE = 300;
/** No editor activity for this long counts as a pause. */
export const IDLE_MS = 5 * 60 * 1000;
/** Usage is only attributed if there was editor activity this recently. */
export const USAGE_WINDOW_MS = 4 * IDLE_MS;
/** A commit older than this when we first see it was not just made here (e.g. pulled). */
export const RECENT_COMMIT_MS = 60 * 60 * 1000;
/** How many commits to walk back when HEAD moved by more than one commit. */
export const MAX_CHAIN = 10;

/**
 * Default ticket pattern: Azure Boards (AB#123), Jira-style keys (PROJ-123,
 * not UTF-8/SHA-256/ISO-8601/RFC-…/CVE-…/HTTP-…) and GitHub issues (#123).
 */
export const DEFAULT_TICKET_PATTERN =
  '\\bAB#\\d+\\b|\\b(?!(?:UTF|SHA|ISO|RFC|CVE|HTTP)-)[A-Z][A-Z0-9]+-\\d+\\b|(?<![\\w#&])#\\d+\\b';

export function emptyState(): ActivityState {
  return { version: 2, units: [], open: [], heads: {} };
}

export function localDate(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ idle handling

/** A tick counts as active time: window focused and editor activity within IDLE_MS. */
export function countsAsActive(now: number, lastSignal: number, focused: boolean): boolean {
  return focused && now - lastSignal <= IDLE_MS;
}

/** Newly used allowance is attributed only if the user was working recently. */
export function attributesUsage(now: number, lastSignal: number): boolean {
  return now - lastSignal <= USAGE_WINDOW_MS;
}

// ------------------------------------------------------------------ tickets

/** Compiles the ticket pattern; falls back to the default if it is empty or invalid. */
export function compileTicketPattern(pattern: string | undefined): RegExp {
  if (pattern && pattern.trim()) {
    try {
      const re = new RegExp(pattern, 'g');
      if (!re.test('')) {
        return new RegExp(pattern, 'g');
      }
    } catch {
      // fall through
    }
  }
  return new RegExp(DEFAULT_TICKET_PATTERN, 'g');
}

/** Ticket ids in a text, in order of appearance, without duplicates. Uses capture group 1 if the pattern has one. */
export function extractTickets(text: string | undefined, re: RegExp): string[] {
  if (!text) {
    return [];
  }
  const out: string[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) {
    const id = (m[1] ?? m[0]).trim();
    if (id && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/** The ticket of a piece of work: ids in the message come first, then the branch name. */
export function ticketFor(message: string | undefined, branch: string | undefined, re: RegExp): string | undefined {
  return extractTickets(message, re)[0] ?? extractTickets(branch, re)[0];
}

/**
 * Link for a ticket from a template with an {id} placeholder (appended if
 * missing). For #123 and AB#123 only the number is inserted. Only http(s).
 */
export function ticketLink(template: string | undefined, ticket: string | undefined): string | undefined {
  const t = template?.trim();
  if (!t || !ticket || !/^https?:\/\//i.test(t)) {
    return undefined;
  }
  const id = encodeURIComponent(ticket.replace(/^[A-Za-z]*#/, ''));
  return t.includes('{id}') ? t.split('{id}').join(id) : t + id;
}

export function subject(message: string | undefined): string {
  return (message ?? '').split('\n')[0].trim().slice(0, 120);
}

// ------------------------------------------------------------------ recording

const sameKey = (u: { repo?: string; branch?: string }, key: ActivityKey) => u.repo === key.repo && (u.branch ?? '') === (key.branch ?? '');

function clone(s: ActivityState): ActivityState {
  return {
    version: 2,
    units: s.units,
    open: s.open.map((o) => ({ ...o })),
    manual: s.manual ? { ...s.manual } : undefined,
    heads: { ...s.heads },
  };
}

/** Finds or creates the open unit for key (mutates the cloned state). */
function openFor(s: ActivityState, key: ActivityKey, start: number): OpenUnit {
  let o = s.open.find((x) => sameKey(x, key));
  if (!o) {
    o = { repo: key.repo, branch: key.branch, start, end: start, activeMs: 0, used: 0 };
    s.open = [o, ...s.open].sort((a, b) => b.end - a.end).slice(0, MAX_OPEN);
  }
  return o;
}

/** Adds active time: to the running manual task, else to the open unit of key. */
export function addActiveTime(state: ActivityState, key: ActivityKey | undefined, now: number, deltaMs: number): ActivityState {
  const delta = Math.max(0, deltaMs);
  const s = clone(state);
  if (s.manual) {
    s.manual.activeMs += delta;
    s.manual.end = now;
    return s;
  }
  if (!key) {
    return state;
  }
  const o = openFor(s, key, now - delta);
  o.activeMs += delta;
  o.end = now;
  return s;
}

/** Attributes allowance usage (only if positive): to the manual task, else to the open unit of key. */
export function addUsage(state: ActivityState, key: ActivityKey | undefined, now: number, used: number): ActivityState {
  if (!(used > 0)) {
    return state;
  }
  const s = clone(state);
  if (s.manual) {
    s.manual.used += used;
    s.manual.end = now;
    return s;
  }
  if (!key) {
    return state;
  }
  const o = openFor(s, key, now);
  o.used += used;
  o.end = now;
  return s;
}

function pushUnit(s: ActivityState, u: WorkUnit): void {
  s.units = [u, ...s.units].sort((a, b) => b.end - a.end).slice(0, MAX_UNITS);
}

/**
 * Closes the open unit of key with a commit (title = commit subject). Without
 * an open unit, a unit without time is recorded (the commit still counts).
 * Ignored if the commit was already recorded.
 */
export function closeWithCommit(state: ActivityState, key: ActivityKey, commit: CommitInfo, now: number): ActivityState {
  if (state.units.some((u) => u.hash === commit.hash)) {
    return state;
  }
  const s = clone(state);
  const o = s.open.find((x) => sameKey(x, key));
  s.open = s.open.filter((x) => x !== o);
  const end = commit.time ?? now;
  pushUnit(s, {
    id: `commit:${commit.hash}`,
    kind: 'commit',
    repo: key.repo,
    branch: key.branch,
    message: commit.message.trim().slice(0, MAX_MESSAGE),
    hash: commit.hash,
    start: Math.min(o?.start ?? end, end),
    end,
    activeMs: o?.activeMs ?? 0,
    used: o?.used ?? 0,
    commits: 1,
  });
  return s;
}

/** Starts a manual task (finishing a running one first). */
export function startManual(state: ActivityState, name: string, key: ActivityKey | undefined, now: number): ActivityState {
  const n = name.trim().slice(0, 200);
  if (!n) {
    return state;
  }
  const s = finishManual(state, now);
  return { ...s, manual: { name: n, repo: key?.repo, branch: key?.branch, start: now, end: now, activeMs: 0, used: 0 } };
}

/** Finishes the running manual task, recording it as a 'manual' unit. */
export function finishManual(state: ActivityState, now: number): ActivityState {
  const m = state.manual;
  if (!m) {
    return state;
  }
  const s = clone(state);
  s.manual = undefined;
  pushUnit(s, {
    id: `manual:${m.start}`,
    kind: 'manual',
    repo: m.repo ?? '',
    branch: m.branch,
    message: m.name,
    start: m.start,
    end: Math.max(now, m.start),
    activeMs: m.activeMs,
    used: m.used,
    commits: 0,
  });
  return s;
}

/** Remembers the HEAD commit of a repository root. */
export function setHead(state: ActivityState, root: string, hash: string): ActivityState {
  return state.heads[root] === hash ? state : { ...state, heads: { ...state.heads, [root]: hash } };
}

// ------------------------------------------------------------------ commit detection

const sameEmail = (a: string | undefined, b: string | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * True if `c` is a commit the user just made on top of `prevHead`: a
 * single-parent commit whose parent is the previous HEAD, authored with the
 * repository's user.email and not older than RECENT_COMMIT_MS. Checkouts,
 * pulls of others' commits, rebases, amends and merges don't qualify.
 */
export function isOwnCommit(c: CommitInfo, prevHead: string | undefined, userEmail: string | undefined, now: number): boolean {
  return (
    !!prevHead &&
    c.hash !== prevHead &&
    c.parents.length === 1 &&
    c.parents[0] === prevHead &&
    sameEmail(c.authorEmail, userEmail) &&
    (c.time === undefined || now - c.time <= RECENT_COMMIT_MS)
  );
}

/**
 * The commits the user made since `prevHead`, oldest first. Walks back from
 * the new HEAD (up to MAX_CHAIN commits) while each commit is an own,
 * recent, single-parent commit; returns [] unless that chain reaches
 * `prevHead` (so a checkout/pull/rebase never counts).
 */
export async function newOwnCommits(
  prevHead: string | undefined,
  head: string,
  getCommit: (hash: string) => Promise<CommitInfo | undefined>,
  userEmail: string | undefined,
  now: number,
): Promise<CommitInfo[]> {
  if (!prevHead || head === prevHead || !userEmail) {
    return [];
  }
  const chain: CommitInfo[] = [];
  let hash = head;
  for (let i = 0; i < MAX_CHAIN; i++) {
    let c: CommitInfo | undefined;
    try {
      c = await getCommit(hash);
    } catch {
      return [];
    }
    if (!c || !isOwnCommit(c, c.parents[0], userEmail, now)) {
      return [];
    }
    chain.push(c);
    if (c.parents[0] === prevHead) {
      return chain.reverse();
    }
    hash = c.parents[0];
  }
  return [];
}

// ------------------------------------------------------------------ migration

/** Reads stored data: the current format, or the old per-branch/per-day items (→ 'legacy'). */
export function migrate(raw: unknown): ActivityState {
  if (Array.isArray(raw)) {
    const units: WorkUnit[] = raw
      .filter((i) => i && typeof i === 'object' && typeof i.start === 'number' && typeof i.end === 'number')
      .map((i) => ({
        id: `legacy:${String(i.id ?? `${i.repo}::${i.branch ?? ''}::${i.start}`)}`,
        kind: 'legacy' as const,
        repo: String(i.repo ?? ''),
        branch: typeof i.branch === 'string' ? i.branch : undefined,
        message: typeof i.detail === 'string' ? i.detail : undefined,
        day: typeof i.day === 'string' ? i.day : undefined,
        start: i.start,
        end: i.end,
        activeMs: Math.max(0, Number(i.activeMs) || 0),
        used: Math.max(0, Number(i.used) || 0),
        commits: 0,
      }));
    return { ...emptyState(), units: units.sort((a, b) => b.end - a.end).slice(0, MAX_UNITS) };
  }
  if (raw && typeof raw === 'object' && (raw as ActivityState).version === 2) {
    const r = raw as Partial<ActivityState>;
    return {
      version: 2,
      units: Array.isArray(r.units) ? r.units.slice(0, MAX_UNITS) : [],
      open: Array.isArray(r.open) ? r.open.slice(0, MAX_OPEN) : [],
      manual: r.manual && typeof r.manual.name === 'string' ? r.manual : undefined,
      heads: r.heads && typeof r.heads === 'object' ? { ...r.heads } : {},
    };
  }
  return emptyState();
}

// ------------------------------------------------------------------ display

export interface ActivityItemView {
  id: string;
  title: string;
  ticket?: string;
  ticketUrl?: string;
  details: string[];
  kind: 'ticket' | 'commit' | 'manual' | 'legacy';
  repo: string;
  branch?: string;
  start: number;
  end: number;
  activeMinutes: number;
  used: number;
  commits: number;
}

export interface DisplayOptions {
  ticketPattern: RegExp;
  ticketUrl?: string;
  /** Title of a legacy item (default: branch or repo, plus the day for per-day items). */
  legacyTitle?: (u: WorkUnit) => string;
  /** Max number of items (default 50). */
  limit?: number;
}

const minutes = (ms: number) => Math.round(ms / 60_000);
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Finished work for the dashboard, newest first: units with the same ticket
 * form one 'ticket' item (summed, details = newest subjects, max 5); units
 * without a ticket stay individual ('commit' / 'manual'); old items stay 'legacy'.
 * GitHub-style #123 tickets are grouped per repository.
 */
export function buildItems(units: WorkUnit[], o: DisplayOptions): ActivityItemView[] {
  const groups = new Map<string, { ticket: string; units: WorkUnit[] }>();
  /** Items in order of their newest unit; a string is a ticket group key. */
  const order: (ActivityItemView | string)[] = [];
  const label = (u: WorkUnit) => (u.kind === 'manual' ? (u.message ?? '') : subject(u.message));
  for (const u of [...units].sort((a, b) => b.end - a.end)) {
    if (u.kind === 'legacy') {
      const title = o.legacyTitle ? o.legacyTitle(u) : u.day ? `${u.branch ?? u.repo} · ${u.day}` : (u.branch ?? u.repo);
      order.push(view(u.id, 'legacy', title, u.message ? [u.message] : [], [u], o));
      continue;
    }
    const ticket = ticketFor(u.message, u.branch, o.ticketPattern);
    if (!ticket) {
      const s = label(u);
      order.push(view(u.id, u.kind, s, s ? [s] : [], [u], o));
      continue;
    }
    const gk = (ticket.startsWith('#') ? `${u.repo}${ticket}` : ticket).toUpperCase();
    const g = groups.get(gk);
    if (g) {
      g.units.push(u);
    } else {
      groups.set(gk, { ticket, units: [u] });
      order.push(gk);
    }
  }
  return order.slice(0, o.limit ?? 50).map((entry) => {
    if (typeof entry !== 'string') {
      return entry;
    }
    const g = groups.get(entry)!;
    const details: string[] = [];
    for (const u of g.units) {
      const s = label(u);
      if (s && !details.includes(s) && details.length < 5) {
        details.push(s);
      }
    }
    const kind = g.units.every((u) => u.kind === 'manual') ? 'manual' : 'ticket';
    return view(`ticket:${entry}`, kind, g.ticket, details, g.units, o, g.ticket);
  });
}

/** One display item from units (newest first); sums time, usage and commits. */
function view(
  id: string,
  kind: ActivityItemView['kind'],
  title: string,
  details: string[],
  us: WorkUnit[],
  o: DisplayOptions,
  ticket?: string,
): ActivityItemView {
  return {
    id,
    title,
    ticket,
    ticketUrl: ticketLink(o.ticketUrl, ticket),
    details,
    kind,
    repo: us[0].repo,
    branch: us[0].branch,
    start: Math.min(...us.map((u) => u.start)),
    end: Math.max(...us.map((u) => u.end)),
    activeMinutes: minutes(us.reduce((a, u) => a + u.activeMs, 0)),
    used: round1(us.reduce((a, u) => a + u.used, 0)),
    commits: us.reduce((a, u) => a + u.commits, 0),
  };
}

export interface CurrentView {
  /** undefined → the caller shows "Uncommitted work on <branch>". */
  title?: string;
  ticket?: string;
  ticketUrl?: string;
  manual: boolean;
  repo?: string;
  branch?: string;
  startedAt: number;
  activeMinutes: number;
  used: number;
}

/** The unit currently worked on: the manual task, else the open unit of key. */
export function currentWork(state: ActivityState, key: ActivityKey | undefined, o: DisplayOptions): CurrentView | undefined {
  const m = state.manual;
  if (m) {
    const ticket = ticketFor(m.name, undefined, o.ticketPattern);
    return {
      title: m.name,
      ticket,
      ticketUrl: ticketLink(o.ticketUrl, ticket),
      manual: true,
      repo: m.repo,
      branch: m.branch,
      startedAt: m.start,
      activeMinutes: minutes(m.activeMs),
      used: round1(m.used),
    };
  }
  const open = key && state.open.find((x) => sameKey(x, key));
  if (!open) {
    return undefined;
  }
  const ticket = ticketFor(undefined, open.branch, o.ticketPattern);
  return {
    title: ticket,
    ticket,
    ticketUrl: ticketLink(o.ticketUrl, ticket),
    manual: false,
    repo: open.repo,
    branch: open.branch,
    startedAt: open.start,
    activeMinutes: minutes(open.activeMs),
    used: round1(open.used),
  };
}
