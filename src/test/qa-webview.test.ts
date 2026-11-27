/**
 * QA: renders media/dashboard with a REAL model produced by the extension
 * (fake vscode, see qa-vscode-mock.ts) in headless Chromium via Playwright and
 * checks what the user sees. Skipped when Playwright/Chromium is not
 * available (it is not a dependency of this project).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { BODIES, createFakeVscode, fakeContext, fakeWebviewView, json, loadExtension, ROOT, stubFetch } from './qa-vscode-mock';

const NOW = Date.UTC(2026, 10, 26, 12); // Thu 26 Nov 2026
const D = 86_400_000;

function loadPlaywright(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('playwright');
  } catch {
    try {
      const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(path.join(root, 'playwright'));
    } catch {
      return undefined;
    }
  }
}

async function makeModel(t: TestContext, tz: string, locale: string, body: unknown, wd = ['mon', 'tue', 'thu'], perDay = 15): Promise<any> {
  const prevTz = process.env.TZ;
  process.env.TZ = tz;
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const env = createFakeVscode(locale);
  env.config.set('contingentWatcher.budget.workDays', wd);
  env.config.set('contingentWatcher.budget.reserve', 20);
  const stub = stubFetch(() => json(body));
  const ext = loadExtension(env);
  const ctx = fakeContext(env);
  const ids = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const days = wd.map((d) => ids.indexOf(d));
  const history: { t: number; used: number }[] = [];
  let used = 0;
  for (let x = Date.UTC(2026, 10, 1, 12); x <= NOW; x += D) {
    if (days.includes(new Date(x).getUTCDay())) {
      used = Math.min(300, used + perDay);
    }
    history.push({ t: x, used });
  }
  await ctx.globalState.update('history', history);
  ext.activate(ctx);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const view = fakeWebviewView();
  env.viewProviders.get('contingentWatcher.dashboard').resolveWebviewView(view, {}, {});
  view.webview.send({ type: 'ready' });
  const model = view.webview.posted.filter((m: any) => m.type === 'model').at(-1).model;
  ctx.subscriptions.forEach((d) => d.dispose());
  stub.restore();
  t.mock.timers.reset();
  if (prevTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = prevTz;
  }
  return model;
}

const pw = loadPlaywright();
let browser: any;
async function getBrowser(): Promise<any> {
  if (!browser) {
    browser = await pw.chromium.launch();
  }
  return browser;
}
test.after(async () => browser?.close());

async function render(model: any, tz = 'UTC', locale = 'en-US') {
  const b = await getBrowser();
  const ctx = await b.newContext({ timezoneId: tz, locale, viewport: { width: 420, height: 1400 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(5000);
  const errors: string[] = [];
  p.on('pageerror', (e: Error) => errors.push(String(e)));
  await p.clock.install({ time: new Date(NOW) });
  const css = fs.readFileSync(path.join(ROOT, 'media/dashboard/dashboard.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'media/dashboard/dashboard.js'), 'utf8');
  await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body data-icon-font="">
    <main id="app"></main><script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(JSON.parse(JSON.stringify(m))),getState:()=>undefined,setState:()=>undefined});</script>
    <script>${js}</script></body></html>`);
  await p.evaluate((m: any) => (globalThis as any).postMessage({ type: 'model', model: m }, '*'), model);
  await p.waitForTimeout(30);
  return {
    p,
    errors,
    close: () => ctx.close(),
    posted: () => p.evaluate(() => (globalThis as any).__posted.splice(0)),
    text: (sel: string) => p.locator(sel).first().innerText(),
    tiles: async (): Promise<Record<string, { value: string; sub: string }>> =>
      Object.fromEntries(
        await p.$$eval('.tile', (els: any[]) =>
          els.map((e) => [
            (e.querySelector('.tile-label') as any).innerText.trim(),
            { value: (e.querySelector('.tile-value') as any).innerText.trim(), sub: (e as any).innerText },
          ]),
        ),
      ),
    chartCols: (): Promise<string[]> => p.$$eval('.c-hit title', (els: any[]) => els.map((e) => e.textContent ?? '')),
  };
}

const skip = pw ? false : 'Playwright not installed';

test('webview: overview shows the extension values for Mon/Tue/Thu (UTC)', { skip }, async (t) => {
  const model = await makeModel(t, 'UTC', 'en', BODIES.requests(120));
  const v = await render(model);
  t.after(() => v.close());
  assert.equal(await v.text('.gauge-value'), '120');
  assert.equal(await v.text('.gauge-unit'), 'left of 300 requests');
  const tiles = await v.tiles();
  // (120 − 20 reserve) / 1.5 days left (Thu ½ + Mon 30).
  assert.equal(tiles['Daily budget'].value, '66.7/day');
  assert.match(tiles['Daily budget'].sub, /1\.5 budget days left/);
  assert.equal(tiles['Today'].value, String(Math.round(model.metrics.today * 10) / 10));
  assert.equal(Object.keys(tiles).length, 6);
  // Chart: 26 days so far + 4 until reset, off days = not Mon/Tue/Thu.
  const cols = await v.chartCols();
  assert.equal(cols.length, 30);
  const off = await v.p.$$eval('rect.c-off', (e: any[]) => e.length);
  assert.equal(off, 30 - 13);
  assert.match(cols[25], /Thu, Nov 26: .*Today/);
  assert.deepEqual(v.errors, []);
});

test('webview: work-day chips reflect and post the setting; last day cannot be removed', { skip }, async (t) => {
  const model = await makeModel(t, 'UTC', 'en', BODIES.requests(120));
  const v = await render(model);
  t.after(() => v.close());
  await v.posted();
  await v.p.click('[data-k="tab-settings"]');
  const pressed = await v.p.$$eval('.daychip[aria-pressed="true"]', (e: any[]) => e.map((x) => x.getAttribute('data-value')));
  assert.deepEqual(pressed, ['1', '2', '4']);
  assert.equal(await v.p.inputValue('#reserve'), '20');
  await v.p.click('[data-k="day-3"]');
  assert.deepEqual(await v.posted(), [{ type: 'setSetting', key: 'workDays', value: [1, 2, 3, 4] }]);
  for (const d of [1, 2, 3]) {
    await v.p.click(`[data-k="day-${d}"]`);
  }
  await v.posted();
  await v.p.click('[data-k="day-4"]', { force: true });
  assert.deepEqual(await v.posted(), [], 'at least one work day stays');
  // Every switch posts its toggled value.
  for (const [k, key, on] of await v.p.$$eval('[role="switch"]', (els: any[]) =>
    els.map((e) => [e.getAttribute('data-k'), e.getAttribute('data-set'), e.getAttribute('aria-checked')]),
  )) {
    await v.p.click(`[data-k="${k}"]`);
    assert.deepEqual(await v.posted(), [{ type: 'setSetting', key, value: on !== 'true' }], String(k));
  }
  assert.deepEqual(v.errors, []);
});

test('webview: German credits account renders German labels and the credits unit', { skip }, async (t) => {
  const model = await makeModel(t, 'UTC', 'de', BODIES.credits(1300));
  const v = await render(model, 'UTC', 'de-DE');
  t.after(() => v.close());
  assert.equal(await v.text('.gauge-value'), '1.300');
  assert.match(await v.text('.gauge-unit'), /von 3\.900 Credits/);
  const body = await v.text('#app');
  for (const english of ['Daily budget', 'Today', 'Buffer', 'left of', 'requests']) {
    assert.ok(!body.includes(english), `"${english}" on the German overview`);
  }
  assert.match(body, /Tagesbudget/);
  assert.deepEqual(v.errors, []);
});

test(
  'webview: chart in Los Angeles shows the last cycle day (Mon 30 Nov, until 16:00 PST)',
  { skip },
  async (t) => {
    const model = await makeModel(t, 'America/Los_Angeles', 'en', BODIES.requests(120));
    const v = await render(model, 'America/Los_Angeles');
    t.after(() => v.close());
    const cols = await v.chartCols();
    assert.match(cols[cols.length - 1], /Nov 30/);
  },
);

test(
  'webview: allowance used up today → remaining days are shown as empty',
  { skip },
  async (t) => {
    const model = await makeModel(t, 'UTC', 'en', BODIES.requests(0), ['mon', 'tue', 'thu'], 25);
    assert.equal(model.forecast.status, 'exhausted');
    const v = await render(model);
    t.after(() => v.close());
    const cols = await v.chartCols();
    assert.match(cols[cols.length - 1], /empty/i, cols[cols.length - 1]);
  },
);
