import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActivityState,
  addActiveTime,
  addUsage,
  attributesUsage,
  buildItems,
  closeWithCommit,
  CommitInfo,
  compileTicketPattern,
  countsAsActive,
  currentWork,
  DEFAULT_TICKET_PATTERN,
  emptyState,
  extractTickets,
  finishManual,
  IDLE_MS,
  isOwnCommit,
  MAX_UNITS,
  migrate,
  newOwnCommits,
  RECENT_COMMIT_MS,
  setHead,
  startManual,
  ticketFor,
  ticketLink,
  WorkUnit,
} from '../core/activity';

const T0 = new Date(2026, 10, 20, 10).getTime();
const MIN = 60_000;
const RE = compileTicketPattern(DEFAULT_TICKET_PATTERN);
const MAIN = { repo: 'app', branch: 'main' };
const ME = 'me@example.com';

const commit = (hash: string, parent: string | string[], message: string, o: Partial<CommitInfo> = {}): CommitInfo => ({
  hash,
  message,
  parents: Array.isArray(parent) ? parent : [parent],
  authorEmail: ME,
  time: T0,
  ...o,
});

/** Works `minutes` on key (in 30 s ticks), starting at t. */
function work(s: ActivityState, key: { repo: string; branch?: string } | undefined, t: number, minutes: number): ActivityState {
  for (let i = 1; i <= minutes * 2; i++) {
    s = addActiveTime(s, key, t + i * 30_000, 30_000);
  }
  return s;
}

const view = (s: ActivityState, ticketUrl = '') => buildItems(s.units, { ticketPattern: RE, ticketUrl });

// ------------------------------------------------------------------ commit detection

test('own commit: parent is the previous HEAD, own email (case-insensitive), recent', () => {
  assert.ok(isOwnCommit(commit('b', 'a', 'x'), 'a', ME, T0));
  assert.ok(isOwnCommit(commit('b', 'a', 'x', { authorEmail: ' Me@Example.COM ' }), 'a', ME, T0));
  assert.ok(isOwnCommit(commit('b', 'a', 'x', { time: undefined }), 'a', ME, T0), 'unknown date is fine');
});

test('not an own commit: checkout, pull of others, merge, rebase/amend, old commit, no email', () => {
  // Checkout to an unrelated commit / branch.
  assert.ok(!isOwnCommit(commit('z', 'y', 'x'), 'a', ME, T0));
  // Fast-forward pull of a colleague's commit on top of our HEAD.
  assert.ok(!isOwnCommit(commit('b', 'a', 'x', { authorEmail: 'colleague@example.com' }), 'a', ME, T0));
  // Merge commit (e.g. "git pull" without fast-forward).
  assert.ok(!isOwnCommit(commit('m', ['a', 'o'], "Merge branch 'main'"), 'a', ME, T0));
  // Amend / rebase: same parent as the old HEAD, not the old HEAD itself.
  assert.ok(!isOwnCommit(commit('a2', 'p', 'x'), 'a', ME, T0));
  // Own commit made long ago elsewhere and pulled now.
  assert.ok(!isOwnCommit(commit('b', 'a', 'x', { time: T0 - RECENT_COMMIT_MS - MIN }), 'a', ME, T0));
  // No user.email / no previous HEAD / HEAD unchanged.
  assert.ok(!isOwnCommit(commit('b', 'a', 'x'), 'a', undefined, T0));
  assert.ok(!isOwnCommit(commit('b', 'a', 'x', { authorEmail: undefined }), 'a', ME, T0));
  assert.ok(!isOwnCommit(commit('b', 'a', 'x'), undefined, ME, T0));
  assert.ok(!isOwnCommit(commit('a', 'a', 'x'), 'a', ME, T0));
});

test('newOwnCommits: walks several quick own commits back to the previous HEAD, oldest first', async () => {
  const db = new Map<string, CommitInfo>([
    ['b', commit('b', 'a', 'one')],
    ['c', commit('c', 'b', 'two')],
    ['d', commit('d', 'c', 'three')],
  ]);
  const get = async (h: string) => db.get(h);
  assert.deepEqual((await newOwnCommits('a', 'd', get, ME, T0)).map((c) => c.hash), ['b', 'c', 'd']);
  assert.deepEqual((await newOwnCommits('a', 'b', get, ME, T0)).map((c) => c.hash), ['b']);
  // Chain does not reach the previous HEAD (checkout to another branch).
  assert.deepEqual(await newOwnCommits('x', 'd', get, ME, T0), []);
  // A colleague's commit in between (pull): nothing counts.
  db.set('c', commit('c', 'b', 'two', { authorEmail: 'other@example.com' }));
  assert.deepEqual(await newOwnCommits('a', 'd', get, ME, T0), []);
  // Unchanged HEAD, unknown previous HEAD, no email, failing lookup.
  assert.deepEqual(await newOwnCommits('a', 'a', get, ME, T0), []);
  assert.deepEqual(await newOwnCommits(undefined, 'b', get, ME, T0), []);
  assert.deepEqual(await newOwnCommits('a', 'b', get, '', T0), []);
  assert.deepEqual(
    await newOwnCommits('a', 'b', async () => {
      throw new Error('bad object');
    }, ME, T0),
    [],
  );
});

test('newOwnCommits: gives up after MAX_CHAIN commits', async () => {
  const get = async (h: string) => commit(h, String(Number(h) - 1), `c${h}`);
  assert.equal((await newOwnCommits('0', '10', get, ME, T0)).length, 10);
  assert.deepEqual(await newOwnCommits('0', '11', get, ME, T0), []);
});

// ------------------------------------------------------------------ units

test('a commit closes the open unit of its repo+branch: title = subject, end = commit time', () => {
  let s = work(emptyState(), MAIN, T0, 20);
  s = addUsage(s, MAIN, T0 + 10 * MIN, 4);
  s = work(s, { repo: 'app', branch: 'feature' }, T0, 5);
  s = closeWithCommit(s, MAIN, commit('b', 'a', 'Fix login redirect\n\nLonger body', { time: T0 + 21 * MIN }), T0 + 22 * MIN);
  assert.equal(s.units.length, 1);
  const u = s.units[0];
  assert.equal(u.kind, 'commit');
  assert.equal(u.activeMs, 20 * MIN);
  assert.equal(u.used, 4);
  assert.equal(u.end, T0 + 21 * MIN);
  assert.equal(u.start, T0);
  assert.deepEqual(s.open.map((o) => o.branch), ['feature'], 'other branches stay open');
  const [item] = view(s);
  assert.equal(item.kind, 'commit');
  assert.equal(item.title, 'Fix login redirect');
  assert.deepEqual(item.details, ['Fix login redirect']);
  assert.equal(item.commits, 1);
  assert.equal(item.activeMinutes, 20);
  // New work on main starts a fresh unit.
  s = work(s, MAIN, T0 + 30 * MIN, 3);
  assert.equal(s.open.find((o) => o.branch === 'main')!.activeMs, 3 * MIN);
});

test('quick successive commits each close their (tiny) unit; duplicates are ignored', () => {
  let s = work(emptyState(), MAIN, T0, 10);
  s = closeWithCommit(s, MAIN, commit('b', 'a', 'one', { time: T0 + 11 * MIN }), T0 + 11 * MIN);
  s = closeWithCommit(s, MAIN, commit('c', 'b', 'two', { time: T0 + 11 * MIN + 5000 }), T0 + 11 * MIN);
  s = closeWithCommit(s, MAIN, commit('c', 'b', 'two'), T0 + 12 * MIN);
  assert.deepEqual(s.units.map((u) => [u.message, u.activeMs]), [
    ['two', 0],
    ['one', 10 * MIN],
  ]);
});

test('start of a unit and the time stamps of open work', () => {
  const s = work(emptyState(), MAIN, T0, 1);
  assert.equal(s.open[0].start, T0, 'first tick counts back by its length');
  assert.equal(s.open[0].end, T0 + MIN);
  assert.equal(addActiveTime(emptyState(), undefined, T0, 30_000).open.length, 0, 'no workspace, no unit');
});

test('idle handling: only focused ticks with recent editor activity count', () => {
  assert.ok(countsAsActive(T0, T0 - IDLE_MS, true));
  assert.ok(!countsAsActive(T0, T0 - IDLE_MS - 1, true));
  assert.ok(!countsAsActive(T0, T0, false));
  assert.ok(attributesUsage(T0, T0 - 4 * IDLE_MS));
  assert.ok(!attributesUsage(T0, T0 - 4 * IDLE_MS - 1));
});

test('heads: remembered per repository root', () => {
  const s = setHead(emptyState(), '/w/app', 'a');
  assert.equal(setHead(s, '/w/app', 'a'), s);
  assert.deepEqual(setHead(s, '/w/lib', 'x').heads, { '/w/app': 'a', '/w/lib': 'x' });
});

// ------------------------------------------------------------------ tickets

test('ticket extraction: Jira, GitHub, Azure Boards; no false positives like UTF-8', () => {
  assert.deepEqual(extractTickets('PROJ-12: fix, refs #45 and AB#678', RE), ['PROJ-12', '#45', 'AB#678']);
  assert.deepEqual(extractTickets('Fix UTF-8 and SHA-256 handling, see RFC-7231, ISO-8601', RE), []);
  assert.deepEqual(extractTickets('feature/ABC2-7-login', RE), ['ABC2-7']);
  assert.deepEqual(extractTickets('color &#123; and issue#5 and x-1', RE), []);
  assert.deepEqual(extractTickets('PROJ-1 PROJ-1', RE), ['PROJ-1']);
  assert.deepEqual(extractTickets(undefined, RE), []);
});

test('ticket precedence: ids in the message first, then the branch', () => {
  assert.equal(ticketFor('PROJ-2 fix', 'feature/PROJ-1-login', RE), 'PROJ-2');
  assert.equal(ticketFor('fix typo', 'feature/PROJ-1-login', RE), 'PROJ-1');
  assert.equal(ticketFor('fix typo', 'main', RE), undefined);
});

test('custom ticket pattern: capture group, invalid or empty-matching patterns fall back', () => {
  const custom = compileTicketPattern('ticket-(\\d+)');
  assert.deepEqual(extractTickets('ticket-9 and ticket-10', custom), ['9', '10']);
  assert.equal(compileTicketPattern('([').source, RE.source);
  assert.equal(compileTicketPattern('x*').source, RE.source);
  assert.equal(compileTicketPattern('  ').source, RE.source);
});

test('ticket links: {id} template, number only for #/AB#, only http(s)', () => {
  assert.equal(ticketLink('https://jira.example.com/browse/{id}', 'PROJ-1'), 'https://jira.example.com/browse/PROJ-1');
  assert.equal(ticketLink('https://github.com/o/r/issues/{id}', '#45'), 'https://github.com/o/r/issues/45');
  assert.equal(ticketLink('https://dev.azure.com/o/p/_workitems/edit/{id}', 'AB#678'), 'https://dev.azure.com/o/p/_workitems/edit/678');
  assert.equal(ticketLink('https://t.example.com/', 'X-1'), 'https://t.example.com/X-1');
  assert.equal(ticketLink('', 'X-1'), undefined);
  assert.equal(ticketLink('javascript:alert({id})', 'X-1'), undefined);
  assert.equal(ticketLink('https://t/{id}', undefined), undefined);
  assert.equal(ticketLink('https://t/{id}', 'a b/c'), 'https://t/a%20b%2Fc');
});

// ------------------------------------------------------------------ grouping

test('grouping: units with the same ticket become one item; others stay individual', () => {
  let s = emptyState();
  const feat = { repo: 'app', branch: 'feature/PROJ-1-login' };
  s = work(s, feat, T0, 30);
  s = addUsage(s, feat, T0 + MIN, 2);
  s = closeWithCommit(s, feat, commit('b', 'a', 'Login form', { time: T0 + 31 * MIN }), T0);
  s = work(s, MAIN, T0 + 40 * MIN, 10);
  s = closeWithCommit(s, MAIN, commit('c', 'x', 'Fix typo', { time: T0 + 51 * MIN }), T0);
  s = work(s, MAIN, T0 + 60 * MIN, 15);
  s = addUsage(s, MAIN, T0 + 61 * MIN, 1.25);
  s = closeWithCommit(s, MAIN, commit('d', 'c', 'PROJ-1: validation', { time: T0 + 76 * MIN }), T0);
  const items = view(s, 'https://jira/{id}');
  assert.deepEqual(items.map((i) => [i.kind, i.title]), [
    ['ticket', 'PROJ-1'],
    ['commit', 'Fix typo'],
  ]);
  const t = items[0];
  assert.equal(t.ticket, 'PROJ-1');
  assert.equal(t.ticketUrl, 'https://jira/PROJ-1');
  assert.equal(t.commits, 2);
  assert.equal(t.activeMinutes, 45);
  assert.equal(t.used, 3.3);
  assert.equal(t.start, T0);
  assert.equal(t.end, T0 + 76 * MIN);
  assert.deepEqual(t.details, ['PROJ-1: validation', 'Login form'], 'newest first');
  assert.equal(t.branch, 'main', 'newest unit');
  assert.equal(items[1].ticket, undefined);
  assert.equal(items[1].ticketUrl, undefined);
});

test('grouping: details are the 5 newest distinct subjects; #123 tickets group per repository', () => {
  let s = emptyState();
  for (let i = 0; i < 7; i++) {
    s = closeWithCommit(s, MAIN, commit(`h${i}`, 'p', `Step ${i} #7`, { time: T0 + i * MIN }), T0);
  }
  s = closeWithCommit(s, { repo: 'lib', branch: 'main' }, commit('l1', 'p', 'Other repo #7', { time: T0 - MIN }), T0);
  const items = view(s);
  assert.equal(items.length, 2);
  assert.equal(items[0].commits, 7);
  assert.deepEqual(items[0].details, ['Step 6 #7', 'Step 5 #7', 'Step 4 #7', 'Step 3 #7', 'Step 2 #7']);
  assert.equal(items[1].repo, 'lib');
});

test('grouping: Jira tickets group across repositories and case', () => {
  let s = emptyState();
  s = closeWithCommit(s, MAIN, commit('a1', 'p', 'PROJ-3 api', { time: T0 }), T0);
  s = closeWithCommit(s, { repo: 'web', branch: 'main' }, commit('b1', 'p', 'PROJ-3 ui', { time: T0 + MIN }), T0);
  assert.equal(view(s).length, 1);
});

test('grouping: item order follows the newest unit, limit applies', () => {
  let s = emptyState();
  s = closeWithCommit(s, MAIN, commit('1', 'p', 'XY-1 first', { time: T0 }), T0);
  s = closeWithCommit(s, MAIN, commit('2', 'p', 'plain', { time: T0 + MIN }), T0);
  s = closeWithCommit(s, MAIN, commit('3', 'p', 'XY-1 again', { time: T0 + 2 * MIN }), T0);
  assert.deepEqual(view(s).map((i) => i.title), ['XY-1', 'plain']);
  assert.equal(buildItems(s.units, { ticketPattern: RE, limit: 1 }).length, 1);
});

// ------------------------------------------------------------------ manual tasks

test('manual task: takes all time and usage, finishing creates a manual item', () => {
  let s = work(emptyState(), MAIN, T0, 5);
  s = startManual(s, '  Review release notes ', MAIN, T0 + 10 * MIN);
  s = work(s, MAIN, T0 + 10 * MIN, 20);
  s = addUsage(s, MAIN, T0 + 15 * MIN, 3);
  assert.equal(s.open[0].activeMs, 5 * MIN, 'git unit unchanged while the task runs');
  const cur = currentWork(s, MAIN, { ticketPattern: RE })!;
  assert.equal(cur.manual, true);
  assert.equal(cur.title, 'Review release notes');
  assert.equal(cur.activeMinutes, 20);
  assert.equal(cur.used, 3);
  s = finishManual(s, T0 + 40 * MIN);
  assert.equal(s.manual, undefined);
  const [item] = view(s);
  assert.equal(item.kind, 'manual');
  assert.equal(item.title, 'Review release notes');
  assert.deepEqual(item.details, ['Review release notes']);
  assert.equal(item.activeMinutes, 20);
  assert.equal(item.used, 3);
  assert.equal(item.commits, 0);
  assert.equal(item.start, T0 + 10 * MIN);
  assert.equal(item.end, T0 + 40 * MIN);
  // Afterwards time goes to the git unit again.
  s = work(s, MAIN, T0 + 50 * MIN, 1);
  assert.equal(s.open[0].activeMs, 6 * MIN);
  assert.equal(finishManual(s, T0), s, 'finishing without a task is a no-op');
});

test('manual task: starting another finishes the running one; blank names are ignored', () => {
  let s = startManual(emptyState(), 'First', undefined, T0);
  s = work(s, undefined, T0, 2);
  assert.equal(startManual(s, '   ', undefined, T0), s);
  s = startManual(s, 'Second', undefined, T0 + 5 * MIN);
  assert.equal(s.manual?.name, 'Second');
  assert.equal(s.units.length, 1);
  assert.equal(s.units[0].message, 'First');
  assert.equal(s.units[0].activeMs, 2 * MIN);
});

test('manual task with a ticket id groups with commits of that ticket', () => {
  let s = startManual(emptyState(), 'PROJ-9 spec review', MAIN, T0);
  s = work(s, MAIN, T0, 10);
  assert.equal(currentWork(s, MAIN, { ticketPattern: RE, ticketUrl: 'https://j/{id}' })!.ticketUrl, 'https://j/PROJ-9');
  s = finishManual(s, T0 + 10 * MIN);
  assert.deepEqual(view(s).map((i) => [i.kind, i.title]), [['manual', 'PROJ-9']]);
  s = closeWithCommit(s, MAIN, commit('b', 'a', 'PROJ-9 implement', { time: T0 + 20 * MIN }), T0);
  const items = view(s);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'ticket');
  assert.equal(items[0].activeMinutes, 10);
  assert.deepEqual(items[0].details, ['PROJ-9 implement', 'PROJ-9 spec review']);
});

test('current work: open unit of the current key, title from the branch ticket', () => {
  let s = work(emptyState(), { repo: 'app', branch: 'feature/PROJ-4-x' }, T0, 4);
  s = work(s, MAIN, T0, 2);
  const feat = currentWork(s, { repo: 'app', branch: 'feature/PROJ-4-x' }, { ticketPattern: RE })!;
  assert.equal(feat.title, 'PROJ-4');
  assert.equal(feat.manual, false);
  assert.equal(feat.activeMinutes, 4);
  const main = currentWork(s, MAIN, { ticketPattern: RE })!;
  assert.equal(main.title, undefined, 'caller shows "Uncommitted work on main"');
  assert.equal(main.branch, 'main');
  assert.equal(currentWork(s, { repo: 'app', branch: 'other' }, { ticketPattern: RE }), undefined);
  assert.equal(currentWork(s, undefined, { ticketPattern: RE }), undefined);
});

// ------------------------------------------------------------------ migration, cap

test('migration: old per-branch/per-day items become legacy items', () => {
  const old = [
    { id: 'app::main::2026-11-19', repo: 'app', branch: 'main', day: '2026-11-19', start: T0 - 86_400_000, end: T0 - 86_000_000, activeMs: 30 * MIN, used: 2 },
    { id: 'app::feature/x', repo: 'app', branch: 'feature/x', detail: 'Add x', start: T0 - 5000, end: T0, activeMs: 10 * MIN, used: 1 },
    { bogus: true },
  ];
  const s = migrate(old);
  assert.equal(s.version, 2);
  assert.equal(s.units.length, 2);
  assert.ok(s.units.every((u) => u.kind === 'legacy'));
  const items = view(s);
  assert.deepEqual(items.map((i) => [i.kind, i.title, i.details]), [
    ['legacy', 'feature/x', ['Add x']],
    ['legacy', 'main · 2026-11-19', []],
  ]);
  assert.equal(items[1].activeMinutes, 30);
  assert.equal(items[0].ticket, undefined);
  // Custom legacy title (the extension formats the day).
  assert.equal(buildItems(s.units, { ticketPattern: RE, legacyTitle: (u) => `T:${u.branch}` })[0].title, 'T:feature/x');
  // Legacy items survive new work and are not grouped.
  const s2 = closeWithCommit(s, MAIN, commit('b', 'a', 'new'), T0);
  assert.equal(s2.units.length, 3);
});

test('migration: current format round-trips; garbage yields an empty state', () => {
  let s = work(emptyState(), MAIN, T0, 1);
  s = startManual(setHead(s, '/w/app', 'a'), 'Task', MAIN, T0);
  assert.deepEqual(migrate(structuredClone(s)), s);
  for (const raw of [undefined, null, 'x', 42, { version: 1 }]) {
    assert.deepEqual(migrate(raw), emptyState());
  }
});

test('cap: at most MAX_UNITS finished units are kept (oldest dropped)', () => {
  let s = emptyState();
  for (let i = 0; i < MAX_UNITS + 20; i++) {
    s = closeWithCommit(s, MAIN, commit(`h${i}`, 'p', `c${i}`, { time: T0 + i * 1000 }), T0);
  }
  assert.equal(s.units.length, MAX_UNITS);
  assert.equal(s.units[0].message, `c${MAX_UNITS + 19}`);
  assert.ok(!s.units.some((u: WorkUnit) => u.message === 'c0'));
  // Migration caps too.
  const many = Array.from({ length: MAX_UNITS + 5 }, (_, i) => ({ id: String(i), repo: 'r', start: i, end: i, activeMs: 0, used: 0 }));
  assert.equal(migrate(many).units.length, MAX_UNITS);
});

test('state updates are immutable', () => {
  const s0 = work(emptyState(), MAIN, T0, 1);
  const frozen = structuredClone(s0);
  addActiveTime(s0, MAIN, T0 + 5 * MIN, 30_000);
  addUsage(s0, MAIN, T0, 1);
  closeWithCommit(s0, MAIN, commit('b', 'a', 'x'), T0);
  startManual(s0, 'x', MAIN, T0);
  assert.deepEqual(s0, frozen);
});
