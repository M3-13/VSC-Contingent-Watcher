/**
 * QA: manifest / i18n consistency. Static checks over package.json, the nls
 * files, the l10n bundle, src/ and the webview scripts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TIPS } from '../core/tipsData';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PKG: any = JSON.parse(read('package.json'));
const NLS: Record<string, string> = JSON.parse(read('package.nls.json'));
const NLS_DE: Record<string, string> = JSON.parse(read('package.nls.de.json'));
const DE: Record<string, string> = JSON.parse(read('l10n/bundle.l10n.de.json'));

function srcFiles(dir = path.join(ROOT, 'src')): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'test' ? [] : srcFiles(path.join(dir, e.name))) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}
const SRC = srcFiles().map((f) => ({ f, s: fs.readFileSync(f, 'utf8') }));
const ALL_SRC = SRC.map((x) => x.s).join('\n');

const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join();

test('manifest: every %key% has an English and a German nls entry, no stale nls keys', () => {
  const raw = read('package.json');
  const keys = new Set([...raw.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
  assert.deepEqual([...keys].filter((k) => NLS[k] === undefined), [], 'missing in package.nls.json');
  assert.deepEqual([...keys].filter((k) => NLS_DE[k] === undefined), [], 'missing in package.nls.de.json');
  assert.deepEqual(Object.keys(NLS).filter((k) => !keys.has(k)), [], 'unused keys in package.nls.json');
  assert.deepEqual(Object.keys(NLS_DE).filter((k) => NLS[k] === undefined), [], 'German-only nls keys');
});

test('manifest: commands in package.json and registerCommand() match; executed own commands exist', () => {
  const manifest = new Set<string>(PKG.contributes.commands.map((c: { command: string }) => c.command));
  const registered = new Set([...ALL_SRC.matchAll(/registerCommand\(\s*'([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...manifest].filter((c) => !registered.has(c)), [], 'declared but not registered');
  assert.deepEqual([...registered].filter((c) => !manifest.has(c)), [], 'registered but not declared');
  // Commands the code, nls texts and walkthrough refer to.
  const view = PKG.contributes.views.contingentWatcher.map((v: { id: string }) => `${v.id}.focus`);
  const refs = new Set([
    ...[...ALL_SRC.matchAll(/'(contingentWatcher\.[\w.]+)'/g)].map((m) => m[1]),
    ...[...JSON.stringify([NLS, NLS_DE]).matchAll(/command:(contingentWatcher\.[\w.]+)/g)].map((m) => m[1]),
    ...[...JSON.stringify(PKG.contributes.walkthroughs).matchAll(/onCommand:(contingentWatcher\.[\w.]+)/g)].map((m) => m[1]),
  ]);
  const settings = new Set(Object.keys(PKG.contributes.configuration.properties));
  const known = new Set([
    ...manifest,
    ...view,
    ...settings,
    'contingentWatcher.status',
    'contingentWatcher.dashboard',
    'contingentWatcher.billingToken',
    'contingentWatcher.gettingStarted',
    'contingentWatcher.btw.chosenModel', // globalState key
  ]);
  assert.deepEqual([...refs].filter((r) => !known.has(r)), [], 'unknown contingentWatcher.* ids referenced');
  assert.ok(!/askSparsam/i.test(ALL_SRC + JSON.stringify(PKG)), 'askSparsam removed');
});

test('manifest: views, /btw prompt file and walkthrough media exist', () => {
  assert.ok(ALL_SRC.includes("viewId = 'contingentWatcher.dashboard'"));
  assert.ok(PKG.contributes.views.contingentWatcher.some((v: { id: string }) => v.id === 'contingentWatcher.dashboard'));
  assert.equal(PKG.contributes.chatParticipants, undefined, 'no chat participant');
  for (const f of PKG.contributes.chatPromptFiles) {
    assert.ok(fs.existsSync(path.join(ROOT, f.path)), f.path);
  }
  // chatPromptFiles needs VS Code 1.110+ (also for sending while the agent works).
  assert.match(PKG.engines.vscode, /^\^1\.(1[1-9]\d|[2-9]\d\d)\./);
  for (const step of PKG.contributes.walkthroughs[0].steps) {
    assert.ok(fs.existsSync(path.join(ROOT, step.media.markdown)), step.media.markdown);
  }
  for (const icon of Object.values<{ default: { fontPath: string } }>(PKG.contributes.icons)) {
    assert.ok(fs.existsSync(path.join(ROOT, icon.default.fontPath)));
  }
  // Every icon id the status bar can produce is contributed.
  for (const style of ['level', 'battery', 'ring', 'bars']) {
    for (let l = 0; l <= 4; l++) {
      assert.ok(PKG.contributes.icons[`contingent-${style}-${l}`], `contingent-${style}-${l}`);
    }
  }
});

test('manifest: every setting is read by the code; every read setting is declared', () => {
  const props = Object.keys(PKG.contributes.configuration.properties).map((k) => k.replace(/^contingentWatcher\./, ''));
  const unread = props.filter((k) => !ALL_SRC.includes(`'${k}'`) && !ALL_SRC.includes(`'contingentWatcher.${k}'`));
  assert.deepEqual(unread, [], 'declared but never read');
  // Keys read through getConfiguration(SECTION | 'contingentWatcher').get/inspect/update.
  const reads = new Set<string>();
  for (const { s } of SRC) {
    if (!/getConfiguration\((SECTION|'contingentWatcher')\)/.test(s)) {
      continue;
    }
    for (const m of s.matchAll(/\b(?:c|own|cfg)\s*\.\s*(?:get|inspect)<?[^>(]*>?\(\s*'([\w.]+)'/g)) {
      reads.add(m[1]);
    }
    for (const m of s.matchAll(/getConfiguration\((?:SECTION|'contingentWatcher')\)\s*\.(?:get|update)(?:<[^>]*>)?\(\s*'([\w.]+)'/g)) {
      reads.add(m[1]);
    }
  }
  assert.ok(reads.size > 10, `found ${reads.size} reads`);
  assert.deepEqual([...reads].filter((k) => !props.includes(k)), [], 'read but not declared');
  // Defaults in README table match the manifest for a few key settings.
  const readme = read('README.md');
  assert.ok(readme.includes('`contingentWatcher.budget.workDays` | `mon…fri`'));
  assert.deepEqual(PKG.contributes.configuration.properties['contingentWatcher.budget.workDays'].default, ['mon', 'tue', 'wed', 'thu', 'fri']);
});

test('i18n: every vscode.l10n.t literal and every tip has a German translation with the same placeholders', () => {
  const strings = new Set<string>();
  const re = /l10n\.t\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g;
  for (const { s } of SRC) {
    for (const m of s.matchAll(re)) {
      strings.add((m[1] ?? m[2] ?? m[3]).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n'));
    }
  }
  TIPS.forEach((t) => strings.add(t.text));
  assert.ok(strings.size > 250, `${strings.size} strings`);
  assert.deepEqual([...strings].filter((s) => DE[s] === undefined), [], 'missing German translation');
  assert.deepEqual([...strings].filter((s) => DE[s] !== undefined && placeholders(s) !== placeholders(DE[s])), [], 'placeholder mismatch');
  assert.deepEqual(Object.keys(DE).filter((k) => !strings.has(k)), [], 'stale keys in the German bundle');
  // Only tip texts are passed to l10n.t as non-literals.
  const nonLiteral = SRC.flatMap(({ f, s }) => [...s.matchAll(/l10n\.t\(\s*([^'"`\s][^,)]*)/g)].map((m) => `${path.basename(f)}:${m[1]}`));
  assert.deepEqual(nonLiteral.sort(), ['extension.ts:t.text', 'statusBar.ts:tip.text']);
});

test('i18n: dashboard.js only uses string ids the extension provides', () => {
  const js = read('media/dashboard/dashboard.js');
  const ds = read('src/dashboardStrings.ts');
  const keys = new Set([...ds.matchAll(/^\s*(\w+):\s*vscode\.l10n/gm)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\b(?:t|raw)\(\s*'(\w+)'/g)].map((m) => m[1]));
  for (const m of js.matchAll(/\b(?:t|raw)\(\s*\w+\s*\?\s*'(\w+)'\s*:\s*'(\w+)'/g)) {
    used.add(m[1]);
    used.add(m[2]);
  }
  assert.deepEqual([...used].filter((k) => !keys.has(k)), [], 'dashboard ids without a string (would render the raw id)');
  for (const [prefix, values] of [
    ['color', ['teal', 'violet', 'blue', 'green', 'orange', 'pink']],
    ['icon', ['gauge', 'battery', 'ring', 'bars', 'none']],
    ['unit', ['auto', 'credits', 'requests']],
  ] as [string, string[]][]) {
    for (const v of values) {
      assert.ok(keys.has(`${prefix}_${v}`), `${prefix}_${v}`);
    }
  }
});
