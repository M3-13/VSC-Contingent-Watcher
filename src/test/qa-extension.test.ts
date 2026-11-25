/**
 * QA: extension-level tests. Loads out/extension.js against a fake `vscode`
 * (see qa-vscode-mock.ts), stubs fetch with realistic copilot_internal/user
 * answers and checks status bar, notifications, commands, the dashboard
 * model and every dashboard setting/command.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { BODIES, createFakeVscode, FakeEnv, fakeContext, fakeWebviewView, json, loadExtension, ROOT, stubFetch } from './qa-vscode-mock';

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
/** Thursday 26 Nov 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 26, 12);
const D = 86_400_000;

interface Boot {
  env: FakeEnv;
  ctx: ReturnType<typeof fakeContext>;
  fetchCalls: { url: string; init: any }[];
  item(): any;
  refresh(): Promise<void>;
  dashboard(): { view: any; model(): any; send(m: any): Promise<void> };
  setBody(h: (url: string) => Response | Promise<Response>): void;
  done(): void;
}

const mocked = new WeakSet<TestContext>();
const tick = () => new Promise<void>((r) => setImmediate(r));

/** Waits until the status bar left the loading state and the event loop is quiet. */
async function settle(env: FakeEnv): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await tick();
    const item = env.statusItems.filter((x) => !x.disposed).at(-1);
    if (item && !String(item.text).includes('sync~spin') && i > 10) {
      return;
    }
  }
}

async function boot(
  t: TestContext,
  o: {
    locale?: string;
    config?: Record<string, any>;
    handler?: (url: string) => Response | Promise<Response>;
    now?: number;
    globalState?: Record<string, any>;
    noSession?: boolean;
    secrets?: Record<string, string>;
    extensions?: Record<string, any>;
    activeEditor?: any;
    /** Don't wait for the first refresh (e.g. a fetch that never answers). */
    noWait?: boolean;
  } = {},
): Promise<Boot> {
  if (!mocked.has(t)) {
    t.mock.timers.enable({ apis: ['Date'], now: o.now ?? NOW });
    mocked.add(t);
  } else {
    t.mock.timers.setTime(o.now ?? NOW);
  }
  const env = createFakeVscode(o.locale ?? 'en');
  for (const [k, v] of Object.entries(o.config ?? {})) {
    env.config.set(k, v);
  }
  if (o.noSession) {
    env.session = undefined;
  }
  for (const [k, v] of Object.entries(o.extensions ?? {})) {
    env.extensions.set(k, v);
  }
  env.vscode.window.activeTextEditor = o.activeEditor;
  for (const [k, v] of Object.entries(o.secrets ?? {})) {
    env.secrets.set(k, v);
  }
  let handler = o.handler ?? (() => json(BODIES.requests(120)));
  const stub = stubFetch((u) => handler(u));
  const ext = loadExtension(env);
  const ctx = fakeContext(env);
  for (const [k, v] of Object.entries(o.globalState ?? {})) {
    await ctx.globalState.update(k, v);
  }
  ext.activate(ctx);
  if (!o.noWait) {
    // Wait for the automatic first refresh (start()) to settle.
    await settle(env);
  }
  await tick();
  let view: any;
  const b: Boot = {
    env,
    ctx,
    fetchCalls: stub.calls,
    item: () => env.statusItems.filter((i) => !i.disposed).at(-1),
    refresh: async () => {
      await env.commands.get('contingentWatcher.refresh')!();
      await tick();
    },
    dashboard: () => {
      if (!view) {
        view = fakeWebviewView();
        env.viewProviders.get('contingentWatcher.dashboard').resolveWebviewView(view, {}, {});
        view.webview.send({ type: 'ready' });
      }
      return {
        view,
        model: () => view.webview.posted.filter((m: any) => m.type === 'model').at(-1)?.model,
        send: async (m: any) => {
          view.webview.send(m);
          for (let i = 0; i < 5; i++) {
            await tick();
          }
        },
      };
    },
    setBody: (h) => (handler = h),
    done: () => {
      for (const d of ctx.subscriptions) {
        d.dispose();
      }
      stub.restore();
    },
  };
  t.after(() => b.done());
  return b;
}

const cfg = (b: Boot, key: string) => b.env.config.get(`contingentWatcher.${key}`);

// ------------------------------------------------------------------ status bar

test('status bar: remaining / used / percent / dailyBudget for Mon–Fri and Mon/Tue/Thu', async (t) => {
  const cases: [Record<string, any>, string][] = [
    [{}, '$(contingent-level-2) 120'],
    [{ 'contingentWatcher.statusBar.display': 'used' }, '$(contingent-level-2) 180/300'],
    [{ 'contingentWatcher.statusBar.display': 'percent' }, '$(contingent-level-2) 60%'],
    // Thu 12:00 → Thu ½ + Fri + Mon 30 = 2.5 days → 120 / 2.5 = 48.
    [{ 'contingentWatcher.statusBar.display': 'dailyBudget' }, '$(contingent-level-2) 48/day'],
    // Mon/Tue/Thu → Thu ½ + Mon 30 = 1.5 days → 80.
    [{ 'contingentWatcher.statusBar.display': 'dailyBudget', 'contingentWatcher.budget.workDays': ['mon', 'tue', 'thu'] }, '$(contingent-level-2) 80/day'],
    // Sat only: nothing but Sat 28 → 120/1.
    [{ 'contingentWatcher.statusBar.display': 'dailyBudget', 'contingentWatcher.budget.workDays': ['sat'] }, '$(contingent-level-2) 120/day'],
    // All 7 days: 4.5 days → 26.7.
    [{ 'contingentWatcher.statusBar.display': 'dailyBudget', 'contingentWatcher.budget.workDays': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }, '$(contingent-level-2) 26.7/day'],
    // Legacy countWeekends fallback.
    [{ 'contingentWatcher.statusBar.display': 'dailyBudget', 'contingentWatcher.budget.countWeekends': true }, '$(contingent-level-2) 26.7/day'],
    // Reserve 50 → (120-50)/2.5 = 28.
    [{ 'contingentWatcher.statusBar.display': 'dailyBudget', 'contingentWatcher.budget.reserve': 50 }, '$(contingent-level-2) 28/day'],
    [{ 'contingentWatcher.statusBar.icon': 'battery' }, '$(contingent-battery-2) 120'],
    [{ 'contingentWatcher.statusBar.icon': 'ring' }, '$(contingent-ring-2) 120'],
    [{ 'contingentWatcher.statusBar.icon': 'bars' }, '$(contingent-bars-2) 120'],
    [{ 'contingentWatcher.statusBar.icon': 'none' }, '120'],
  ];
  for (const [config, expected] of cases) {
    await t.test(JSON.stringify(config), async (t2) => {
      const b = await boot(t2, { config });
      assert.equal(b.item().text, expected);
      assert.equal(b.item().command, 'contingentWatcher.showDetails');
      assert.equal(b.item().backgroundColor, undefined, 'on track: no warning background');
      const tip = b.item().tooltip.value as string;
      assert.match(tip, /Remaining: \*\*120\*\* \/ 300 requests/);
      assert.match(tip, /On track/);
      assert.match(tip, /Resets on/);
      if (config['contingentWatcher.budget.reserve']) {
        assert.match(tip, /Reserve: 50/);
      }
    });
  }
});

test('status bar: alignment, colours and warning backgrounds', async (t) => {
  const b = await boot(t, { config: { 'contingentWatcher.statusBar.alignment': 'left', 'contingentWatcher.statusBar.color': 'teal' } });
  assert.equal(b.item().alignment, 1, 'left');
  assert.equal(b.item().color, '#14b8a6');
  // Change alignment at runtime: item is recreated on the right.
  await b.env.vscode.workspace.getConfiguration('contingentWatcher').update('statusBar.alignment', 'right', 1);
  assert.equal(b.item().alignment, 2);
  assert.equal(b.env.statusItems.filter((i) => !i.disposed).length, 1, 'old item disposed');
  await b.env.vscode.workspace.getConfiguration('contingentWatcher').update('statusBar.color', '#f80', 1);
  assert.equal(b.item().color, '#f80');
  await b.env.vscode.workspace.getConfiguration('contingentWatcher').update('statusBar.color', 'not-a-colour', 1);
  assert.equal(b.item().color, undefined);

  // Exhausted → error background with default colour; none with a custom colour.
  b.setBody(() => json(BODIES.requests(0)));
  await b.refresh();
  assert.equal(b.item().text, '$(contingent-level-0) 0');
  assert.equal(b.item().backgroundColor?.id, 'statusBarItem.errorBackground');
  assert.match(b.item().tooltip.value, /Allowance used up/);
  await b.env.vscode.workspace.getConfiguration('contingentWatcher').update('statusBar.color', 'pink', 1);
  assert.equal(b.item().backgroundColor, undefined);
  assert.equal(b.item().color, '#ec4899');
});

test('status bar: credits account shows credits, unit=requests switches back', async (t) => {
  const b = await boot(t, { handler: () => json(BODIES.credits(1300)) });
  assert.equal(b.item().text, '$(contingent-level-2) 1,300');
  const tip = b.item().tooltip.value as string;
  assert.match(tip, /Remaining: \*\*1,300\*\* \/ 3,900 credits/);
  assert.match(tip, /Daily budget: \*\*520\*\* credits/);
  assert.doesNotMatch(tip, /requests/);
  await b.env.vscode.workspace.getConfiguration('contingentWatcher').update('unit', 'requests', 1);
  await b.refresh();
  assert.equal(b.item().text, '$(contingent-level-2) 120');
  assert.match(b.item().tooltip.value, /\/ 300 requests/);
});

test('status bar: unlimited, 401, 403, 404, 500, network error, garbage, no session', async (t) => {
  await t.test('unlimited', async (t2) => {
    const b = await boot(t2, { handler: () => json(BODIES.unlimited()) });
    assert.equal(b.item().text, '$(contingent-level-4) ∞');
    assert.match(String(b.item().tooltip), /Unlimited/);
  });
  await t.test('401 → signed out', async (t2) => {
    const b = await boot(t2, { handler: () => json({ message: 'Bad credentials' }, 401) });
    assert.equal(b.item().text, '$(contingent-level-4) $(account)');
    assert.equal(b.item().command, 'contingentWatcher.signIn');
    assert.match(b.item().tooltip.value, /Sign in with GitHub to see/);
  });
  await t.test('403 → SSO hint', async (t2) => {
    const b = await boot(t2, { handler: () => json({ message: 'Resource protected by organization SAML enforcement' }, 403) });
    assert.equal(b.item().text, '$(contingent-level-4) —');
    assert.match(b.item().tooltip.value, /403/);
  });
  await t.test('404 → no Copilot', async (t2) => {
    const b = await boot(t2, { handler: () => json({ message: 'Not Found' }, 404) });
    assert.equal(b.item().text, '$(contingent-level-4) —');
    assert.match(b.item().tooltip.value, /No metered Copilot quota/);
  });
  await t.test('500 → error', async (t2) => {
    const b = await boot(t2, { handler: () => json({}, 500) });
    assert.equal(b.item().text, '$(contingent-level-4) $(warning)');
    assert.match(String(b.item().tooltip), /HTTP 500/);
  });
  await t.test('network error → error, then cached data marked stale', async (t2) => {
    const b = await boot(t2, {
      handler: () => {
        throw new TypeError('fetch failed');
      },
    });
    assert.equal(b.item().text, '$(contingent-level-4) $(warning)');
    assert.match(String(b.item().tooltip), /fetch failed/);
    // With a cached snapshot the last values stay visible with a history marker.
    b.setBody(() => json(BODIES.requests(120)));
    await b.refresh();
    b.setBody(() => {
      throw new TypeError('fetch failed');
    });
    await b.refresh();
    assert.equal(b.item().text, '$(contingent-level-2) 120 $(history)');
    assert.match(b.item().tooltip.value, /Offline/);
    const m = b.dashboard().model();
    assert.equal(m.state, 'ok');
    assert.equal(m.stale, true);
    assert.equal(m.errorMessage, 'fetch failed');
  });
  await t.test('garbage body → error, no crash', async (t2) => {
    const b = await boot(t2, { handler: () => new Response('<html>rate limited</html>', { status: 200 }) });
    assert.equal(b.item().text, '$(contingent-level-4) $(warning)');
    const b2 = await boot(t2, { handler: () => json({ quota_snapshots: 'nope' }) });
    assert.equal(b2.item().text, '$(contingent-level-4) —', 'no metered quota');
    const b3 = await boot(t2, { handler: () => json(null) });
    assert.equal(b3.item().text, '$(contingent-level-4) —');
  });
  await t.test('no GitHub session → signed out, no request sent', async (t2) => {
    const b = await boot(t2, { noSession: true });
    assert.equal(b.item().text, '$(contingent-level-4) $(account)');
    assert.equal(b.fetchCalls.length, 0);
    assert.ok(b.env.sessionRequests.every((r) => r.opts?.silent), 'no interactive sign-in on startup');
  });
  await t.test('cached snapshot is shown immediately on startup', async (t2) => {
    const last = {
      entitlement: 300, used: 30, remaining: 270, unlimited: false, overagePermitted: false, overageCount: 0,
      resetDate: '2026-12-01T00:00:00.000Z', unit: 'requests', quotaId: 'premium_interactions', fetchedAt: NOW - 3600_000,
    };
    const b = await boot(t2, { globalState: { lastSnapshot: last }, handler: () => new Promise<Response>(() => undefined), noWait: true });
    assert.equal(b.item().text, '$(contingent-level-4) 270');
  });
});

test('request: token header, endpoint, enterprise host and apiUrl override', async (t) => {
  const b = await boot(t);
  assert.equal(b.fetchCalls[0].url, 'https://api.github.com/copilot_internal/user');
  assert.equal(b.fetchCalls[0].init.headers.Authorization, 'token gho_test');
  assert.ok(!b.env.logs.some((l) => l.includes('gho_test')), 'token never logged');
  const b2 = await boot(t, { config: { 'github-enterprise.uri': 'https://acme.ghe.com' } });
  assert.equal(b2.fetchCalls[0].url, 'https://api.acme.ghe.com/copilot_internal/user');
  const b3 = await boot(t, { config: { 'contingentWatcher.auth.apiUrl': 'https://api.example.com/' } });
  assert.equal(b3.fetchCalls[0].url, 'https://api.example.com/copilot_internal/user');
});

// ------------------------------------------------------------------ notifications

test('notifications: once per threshold, highest crossed only, snooze respected', async (t) => {
  // Wed 18 Nov (not in the surplus window).
  const b = await boot(t, { handler: () => json(BODIES.requests(120)), now: Date.UTC(2026, 10, 18, 12) });
  // 60 % used → 50 % notification.
  assert.equal(b.env.notifications.length, 1, JSON.stringify(b.env.notifications));
  assert.equal(b.env.notifications[0].level, 'info');
  assert.match(b.env.notifications[0].message, /50% of your allowance used — 120 requests left, about 14.1 per day/);
  assert.deepEqual(b.env.notifications[0].items, ['Saving tips', 'Details', 'Snooze 24h']);
  await b.refresh();
  assert.equal(b.env.notifications.length, 1, 'not again');
  // Jump to 95 % → only the 90 % warning, 75 % is skipped.
  b.setBody(() => json(BODIES.requests(15)));
  await b.refresh();
  assert.equal(b.env.notifications.length, 2);
  assert.equal(b.env.notifications[1].level, 'warning');
  assert.match(b.env.notifications[1].message, /90%/);
  // Snooze, then 100 % → nothing.
  await b.env.commands.get('contingentWatcher.snooze')!();
  assert.deepEqual(b.env.statusMessages, ['Copilot quota warnings snoozed for 24h']);
  b.setBody(() => json(BODIES.requests(0)));
  await b.refresh();
  assert.equal(b.env.notifications.length, 2, 'snoozed');
  // Unsnooze via dashboard → 100 % message.
  const dash = b.dashboard();
  await dash.send({ type: 'command', command: 'unsnooze' });
  await b.refresh();
  assert.equal(b.env.notifications.length, 3);
  assert.match(b.env.notifications[2].message, /allowance used up/i);
});

test('notifications: "Snooze 24h" answer snoozes; warnings.enabled=false silences', async (t) => {
  const b = await boot(t, { handler: () => json(BODIES.requests(120)) });
  b.env.notificationAnswer = () => 'Snooze 24h';
  b.setBody(() => json(BODIES.requests(60)));
  await b.refresh();
  assert.equal(b.env.notifications.length, 2);
  const until = b.dashboard().model().settings.snoozedUntil;
  assert.equal(until, NOW + 24 * 3600_000);
  const b2 = await boot(t, { config: { 'contingentWatcher.warnings.enabled': false } });
  assert.equal(b2.env.notifications.length, 0);
  // "Saving tips" opens the dashboard.
  const b3 = await boot(t, { handler: () => json(BODIES.requests(299)) });
  b3.env.notificationAnswer = () => 'Saving tips';
  b3.setBody(() => json(BODIES.requests(120)));
  await b3.refresh();
  assert.ok(b3.env.executed.some((e) => e.id === 'contingentWatcher.showTips'));
  assert.ok(b3.env.executed.some((e) => e.id === 'contingentWatcher.dashboard.focus'));
});

test('notifications: surplus hint once per cycle in the last week; off switch works', async (t) => {
  // Thu 26 Nov, only 30 of 300 used → most will expire.
  const b = await boot(t, { handler: () => json(BODIES.requests(270)) });
  assert.equal(b.env.notifications.length, 1);
  assert.match(b.env.notifications[0].message, /About \d+ requests will expire unused on/);
  const m = b.dashboard().model();
  assert.ok(m.surplus && m.surplus.expectedUnused > 200);
  await b.refresh();
  assert.equal(b.env.notifications.length, 1, 'once per cycle');
  const b2 = await boot(t, { handler: () => json(BODIES.requests(270)), config: { 'contingentWatcher.warnings.surplusHint': false } });
  assert.equal(b2.env.notifications.length, 0);
  assert.equal(b2.dashboard().model().surplus, undefined);
  // Mid-month: no hint.
  const b3 = await boot(t, { handler: () => json(BODIES.requests(270)), now: Date.UTC(2026, 10, 10, 12) });
  assert.equal(b3.env.notifications.length, 0);
});

test('notifications: pace warning when the allowance runs out early (once a day)', async (t) => {
  // 10 Nov, 200 of 300 used after 7 work days → empty long before reset.
  const now = Date.UTC(2026, 10, 10, 12);
  const history = [
    { t: now - 3 * D, used: 120 },
    { t: now - 1 * D, used: 170 },
  ];
  const b = await boot(t, {
    now,
    handler: () => json(BODIES.requests(100)),
    globalState: { history, notified: { cycle: '2026-12-01', thresholds: [50] } },
  });
  assert.equal(b.item().backgroundColor?.id, 'statusBarItem.errorBackground');
  assert.match(b.item().tooltip.value, /At this pace empty on/);
  assert.equal(b.env.notifications.length, 1);
  assert.match(b.env.notifications[0].message, /at your current pace the allowance runs out on/);
  await b.refresh();
  assert.equal(b.env.notifications.length, 1, 'once a day');
  const m = b.dashboard().model();
  assert.equal(m.forecast.status, 'critical');
  assert.equal(m.forecast.statusLabel, 'Will run out before reset');
});

// ------------------------------------------------------------------ commands

test('commands: every manifest command is registered and runs; no askSparsam', async (t) => {
  const b = await boot(t);
  const manifest = PKG.contributes.commands.map((c: any) => c.command).sort();
  const registered = [...b.env.commands.keys()].sort();
  assert.deepEqual(registered, manifest);
  assert.ok(!registered.some((c) => /sparsam/i.test(c)));
  assert.ok(!JSON.stringify(PKG).includes('askSparsam'));
  assert.ok(!fs.readFileSync(path.join(ROOT, 'out', 'extension.js'), 'utf8').includes('askSparsam'));

  b.env.quickPickAnswer = () => undefined; // cancel sign-in
  b.env.notificationAnswer = () => undefined;
  for (const id of manifest) {
    await assert.doesNotReject(async () => b.env.commands.get(id)!(), id);
  }
  const ids = b.env.executed.map((e) => e.id);
  assert.ok(ids.includes('contingentWatcher.dashboard.focus'), 'showDetails/showTips focus the dashboard');
  const openSettings = b.env.executed.find((e) => e.id === 'workbench.action.openSettings');
  assert.deepEqual(openSettings?.args, ['@ext:m3-13.copilot-contingent-watcher']);
  assert.ok(b.env.logs.includes('[show]'), 'showLog');
  assert.equal(b.env.webviewPanels.length, 1, 'btw opens the btw window');
  assert.equal(b.env.webviewPanels[0].showOptions.viewColumn, -2);
  assert.match(b.env.webviewPanels[0].webview.html, /btw\.js/);
});

test('commands: guided sign-in for github.com and GHE.com', async (t) => {
  const b = await boot(t, { noSession: true });
  b.env.quickPickAnswer = (items) => items.find((i: any) => i.kind2 === 'github');
  b.env.notificationAnswer = () => undefined;
  b.env.session = { accessToken: 'gho_new', account: { label: 'me', id: '2' }, id: 's2', scopes: ['user:email'] };
  await b.env.commands.get('contingentWatcher.signIn')!();
  assert.equal(cfg(b, 'auth.provider'), 'github');
  assert.equal(b.item().text, '$(contingent-level-2) 120');

  const b2 = await boot(t, { noSession: true });
  b2.env.quickPickAnswer = (items) => items.find((i: any) => i.kind2 === 'ghe');
  b2.env.inputBoxAnswer = () => 'acme.ghe.com/';
  b2.env.notificationAnswer = () => undefined;
  await b2.env.commands.get('contingentWatcher.signIn')!();
  assert.equal(b2.env.config.get('github-enterprise.uri'), 'https://acme.ghe.com');
  assert.equal(cfg(b2, 'auth.provider'), 'github-enterprise');
  // Still no session → explains and offers the log.
  assert.match(b2.env.notifications.at(-1)!.message, /Sign-in did not work/);
  assert.ok(b2.env.sessionRequests.some((r) => r.provider === 'github-enterprise' && r.opts?.createIfNone));

  // Invalid address → cancelled, nothing written.
  const b3 = await boot(t, { noSession: true });
  b3.env.quickPickAnswer = (items) => items.find((i: any) => i.kind2 === 'ghes');
  b3.env.inputBoxAnswer = () => '   ';
  await b3.env.commands.get('contingentWatcher.signIn')!();
  assert.equal(cfg(b3, 'auth.provider'), undefined);
});

test('commands: billing token flow stores the secret and loads per-model usage', async (t) => {
  const b = await boot(t, {
    handler: (u) => {
      if (u.endsWith('/user')) {
        return json({ login: 'octocat' });
      }
      if (u.includes('/settings/billing/premium_request/usage')) {
        return json({
          usageItems: [
            { model: 'Claude Sonnet 4.5', grossQuantity: 30, grossAmount: 1.2 },
            { model: 'GPT-5', grossQuantity: 10, grossAmount: 0.4 },
          ],
        });
      }
      return json(BODIES.requests(120));
    },
  });
  b.env.notificationAnswer = (n) => (n.items.includes('Enter token') ? 'Enter token' : undefined);
  b.env.inputBoxAnswer = () => ' github_pat_abc ';
  await b.env.commands.get('contingentWatcher.configureBillingToken')!();
  assert.equal(b.env.secrets.get('contingentWatcher.billingToken'), 'github_pat_abc');
  const usage = b.fetchCalls.find((c) => c.url.includes('premium_request/usage'))!;
  assert.match(usage.url, /\/users\/octocat\/settings\/billing\/premium_request\/usage\?year=2026&month=11$/);
  assert.equal(usage.init.headers.Authorization, 'Bearer github_pat_abc');
  const m = b.dashboard().model();
  assert.equal(m.models.state, 'ok');
  assert.equal(m.models.showCredits, true);
  assert.deepEqual(
    m.models.items.map((i: any) => [i.model, i.credits, Math.round(i.share * 100)]),
    [
      ['Claude Sonnet 4.5', 120, 75],
      ['GPT-5', 40, 25],
    ],
  );
  assert.equal(m.models.periodLabel, 'November 2026');
  assert.equal(m.settings.billingTokenSet, true);
  await b.dashboard().send({ type: 'command', command: 'clearBillingToken' });
  assert.equal(b.env.secrets.has('contingentWatcher.billingToken'), false);
  assert.equal(b.dashboard().model().models.state, 'notConfigured');
});

// ------------------------------------------------------------------ dashboard model

function workDayHistory(now: number, wd: number[], perDay: number) {
  // One point at 12:00 UTC on each work day so far, used rising by perDay.
  const out: { t: number; used: number }[] = [];
  let used = 0;
  for (let t = Date.UTC(2026, 10, 1, 12); t <= now; t += D) {
    if (wd.includes(new Date(t).getUTCDay())) {
      used += perDay;
    }
    out.push({ t, used });
  }
  return out;
}

test('dashboard model: correct values for work days Mon/Tue/Thu', async (t) => {
  const wd = [1, 2, 4];
  // Work days so far (to Thu 26 12:00): 2,3,5,9,10,12,16,17,19,23,24,26 → 12 × 15 = 180 used.
  const history = workDayHistory(NOW, wd, 15);
  assert.equal(history.at(-1)!.used, 180);
  const b = await boot(t, {
    config: { 'contingentWatcher.budget.workDays': ['mon', 'tue', 'thu'], 'contingentWatcher.budget.reserve': 20 },
    globalState: { history },
  });
  const m = b.dashboard().model();
  assert.equal(m.state, 'ok');
  assert.deepEqual(m.settings.workDays, [1, 2, 4]);
  assert.equal(m.settings.reserve, 20);
  assert.equal(m.quota.remaining, 120);
  assert.equal(m.quota.used, 180);
  assert.equal(m.quota.unitLabel, 'requests');
  // 13 budget days in Nov; elapsed 11.5 (Thu 26 half); left: Thu ½ + Mon 30.
  const close = (a: number, e: number, what: string) => assert.ok(Math.abs(a - e) < 1e-6, `${what}: ${a} vs ${e}`);
  close(m.forecast.daysLeft, 1.5, 'daysLeft');
  close(m.forecast.dailyBudget, (120 - 20) / 1.5, 'dailyBudget');
  close(m.forecast.cycleElapsed, 11.5 / 13, 'cycleElapsed');
  close(m.metrics.planPerDay, 300 / 13, 'planPerDay');
  close(m.metrics.buffer, 300 * (11.5 / 13) - 180, 'buffer');
  // Recent burn: points from 19 Nov 12:00 to 26 Nov 12:00 → 3 budget days (Thu ½, Mon, Tue, Thu ½), 45 used.
  close(m.forecast.burnRate, 45 / 3, 'burnRate');
  close(m.forecast.projectedUsed, 180 + 15 * 1.5, 'projectedUsed');
  assert.equal(m.forecast.status, 'onTrack');
  assert.equal(m.forecast.exhaustionDate, undefined);
  // Daily buckets: sum = used, off days by local weekday.
  const daily = m.metrics.daily as any[];
  close(
    daily.reduce((a, d) => a + d.used, 0),
    180,
    'sum daily',
  );
  for (const d of daily) {
    const [y, mo, da] = d.date.split('-').map(Number);
    assert.equal(d.offDay, !wd.includes(new Date(y, mo - 1, da).getDay()), `offDay ${d.date}`);
  }
  assert.equal(daily.at(-1).offDay, !wd.includes(new Date(NOW).getDay()), 'today');
  // Review: current cycle first.
  assert.equal(m.review.cycles[0].current, true);
  assert.ok(m.tips.length >= 3 && m.tips.length <= 5);
  assert.equal(m.locale, 'en');
  assert.equal(m.strings.tabOverview, 'Overview');
  fs.mkdirSync(path.join(ROOT, 'out', 'test', 'qa-fixtures'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'test', 'qa-fixtures', 'model-mtt.json'), JSON.stringify(m));
});

test('dashboard model: German locale and credits fixtures render translated', async (t) => {
  const b = await boot(t, { locale: 'de', handler: () => json(BODIES.credits(1300)) });
  const m = b.dashboard().model();
  assert.equal(m.locale, 'de');
  assert.equal(m.quota.unitLabel, 'Credits');
  assert.equal(m.strings.tabOverview, 'Übersicht');
  assert.equal(m.forecast.statusLabel, 'Im Plan');
  assert.match(b.item().tooltip.value, /Verbleibend: \*\*1,300\*\* \/ 3,900 Credits/);
  fs.mkdirSync(path.join(ROOT, 'out', 'test', 'qa-fixtures'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'test', 'qa-fixtures', 'model-de-credits.json'), JSON.stringify(m));
  const b2 = await boot(t, { handler: () => json(BODIES.credits(1300)) });
  fs.writeFileSync(path.join(ROOT, 'out', 'test', 'qa-fixtures', 'model-en-credits.json'), JSON.stringify(b2.dashboard().model()));
});

// ------------------------------------------------------------------ dashboard settings / commands

test('dashboard: every setSetting key writes the right configuration key and value', async (t) => {
  const b = await boot(t);
  const dash = b.dashboard();
  const cases: [string, unknown, string, unknown][] = [
    ['display', 'used', 'contingentWatcher.statusBar.display', 'used'],
    ['workDays', [4, 1, 2, 2], 'contingentWatcher.budget.workDays', ['mon', 'tue', 'thu']],
    ['workDays', [0, 6], 'contingentWatcher.budget.workDays', ['sun', 'sat']],
    ['reserve', '25', 'contingentWatcher.budget.reserve', 25],
    ['reserve', -5, 'contingentWatcher.budget.reserve', 0],
    ['thresholds', [90, 50, 50, 150, 0, '75'], 'contingentWatcher.warnings.thresholds', [50, 75, 90]],
    ['warningsEnabled', false, 'contingentWatcher.warnings.enabled', false],
    ['paceWarning', false, 'contingentWatcher.warnings.paceWarning', false],
    ['tipsEnabled', false, 'contingentWatcher.tips.enabled', false],
    ['authProvider', 'github-enterprise', 'contingentWatcher.auth.provider', 'github-enterprise'],
    ['accent', 'violet', 'contingentWatcher.appearance.accentColor', 'violet'],
    ['statusBarIcon', 'ring', 'contingentWatcher.statusBar.icon', 'ring'],
    ['statusBarColor', '#ff8800', 'contingentWatcher.statusBar.color', '#ff8800'],
    ['surplusHint', false, 'contingentWatcher.warnings.surplusHint', false],
    ['activityTracking', false, 'contingentWatcher.activity.enabled', false],
    ['refreshIntervalMinutes', 500, 'contingentWatcher.refreshIntervalMinutes', 120],
    ['refreshIntervalMinutes', 1, 'contingentWatcher.refreshIntervalMinutes', 2],
    ['refreshIntervalMinutes', 15, 'contingentWatcher.refreshIntervalMinutes', 15],
    ['alignment', 'left', 'contingentWatcher.statusBar.alignment', 'left'],
    ['alignment', 'middle', 'contingentWatcher.statusBar.alignment', 'right'],
    ['apiUrl', '  https://api.example.com  ', 'contingentWatcher.auth.apiUrl', 'https://api.example.com'],
    ['preferredModels', [' gpt-4.1 ', 'gpt-4.1', '', 'gpt-5-mini'], 'contingentWatcher.chat.preferredModels', ['gpt-4.1', 'gpt-5-mini']],
    ['btwModel', 'included', 'contingentWatcher.btw.model', 'included'],
    ['btwModel', 'premium', 'contingentWatcher.btw.model', 'chat'],
    ['btwOpenIn', 'window', 'contingentWatcher.btw.openIn', 'window'],
    ['unit', 'credits', 'contingentWatcher.unit', 'credits'],
    ['unit', 'bogus', 'contingentWatcher.unit', 'auto'],
    ['btwIncludeChat', false, 'contingentWatcher.btw.includeChat', false],
    ['copilotCompletions', false, 'github.copilot.enable', { '*': false }],
    ['copilotNextEdit', false, 'github.copilot.nextEditSuggestions.enabled', false],
  ];
  for (const [key, value, cfgKey, expected] of cases) {
    const before = b.env.configWrites.length;
    await dash.send({ type: 'setSetting', key, value });
    const w = b.env.configWrites.slice(before);
    assert.equal(w.length, 1, `${key}=${JSON.stringify(value)} writes once`);
    assert.equal(w[0].key, cfgKey, key);
    assert.deepEqual(w[0].value, expected, `${key}=${JSON.stringify(value)}`);
    assert.equal(w[0].target, 1, 'global');
  }
  // Rejected: empty / invalid work days, unknown key.
  for (const [key, value] of [
    ['workDays', []],
    ['workDays', [7, -1, 'x']],
    ['workDays', 'mon'],
    ['askSparsam', true],
    ['__proto__', 1],
    ['copilotLanguage', true], // no active editor
    ['copilotEagerness', 'high'], // Copilot not installed
  ] as [string, unknown][]) {
    const before = b.env.configWrites.length;
    await dash.send({ type: 'setSetting', key, value });
    assert.equal(b.env.configWrites.length, before, `${key}=${JSON.stringify(value)} is ignored`);
  }
  // Re-rendered with the new values.
  const m = dash.model();
  assert.deepEqual(m.settings.workDays, [0, 6]);
  assert.equal(m.settings.display, 'used');
  assert.equal(b.item().text.endsWith('180/300'), true, 'status bar follows display=used');
  assert.equal(b.item().alignment, 2);
  // Every DashboardSettingKey was exercised.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'dashboardModel.ts'), 'utf8');
  const keys = [...src.split('export type DashboardSettingKey')[1].split(';')[0].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  const tested = new Set([...cases.map((c) => c[0]), 'copilotLanguage', 'copilotEagerness']);
  assert.deepEqual(keys.filter((k) => !tested.has(k)), []);
});

test('dashboard: Copilot options (eagerness, language toggle) with Copilot installed', async (t) => {
  const b = await boot(t, {
    extensions: {
      'GitHub.copilot': {
        id: 'GitHub.copilot',
        packageJSON: {
          contributes: {
            configuration: [{ properties: { 'github.copilot.nextEditSuggestions.eagerness': { type: 'string', enum: ['low', 'medium', 'high'] } } }],
          },
        },
      },
    },
    activeEditor: { document: { uri: { scheme: 'file', path: '/x.ts' }, languageId: 'typescript' }, selection: { isEmpty: true } },
  });
  const dash = b.dashboard();
  const m0 = dash.model();
  assert.equal(m0.settings.copilotCompletions, true);
  assert.equal(m0.settings.copilotNextEdit, true);
  assert.deepEqual(m0.settings.copilotLanguage, { id: 'typescript', label: 'typescript', enabled: true });
  assert.deepEqual(m0.settings.copilotEagerness, { value: 'low', options: ['low', 'medium', 'high'] });
  assert.equal(m0.settings.copilotSnoozeAvailable, true);
  let before = b.env.configWrites.length;
  await dash.send({ type: 'setSetting', key: 'copilotLanguage', value: false });
  assert.deepEqual(b.env.configWrites.slice(before).map((w) => [w.key, w.value]), [['github.copilot.enable', { typescript: false }]]);
  before = b.env.configWrites.length;
  await dash.send({ type: 'setSetting', key: 'copilotEagerness', value: 'high' });
  await dash.send({ type: 'setSetting', key: 'copilotEagerness', value: 'turbo' });
  assert.deepEqual(b.env.configWrites.slice(before).map((w) => [w.key, w.value]), [['github.copilot.nextEditSuggestions.eagerness', 'high']]);
  await dash.send({ type: 'command', command: 'snoozeCompletions' });
  assert.ok(b.env.executed.some((e) => e.id === 'github.copilot.completions.snooze'));
  fs.mkdirSync(path.join(ROOT, 'out', 'test', 'qa-fixtures'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'test', 'qa-fixtures', 'model-copilot.json'), JSON.stringify(dash.model()));
});

test('dashboard: every DashboardCommand is handled', async (t) => {
  const b = await boot(t);
  const dash = b.dashboard();
  b.env.quickPickAnswer = () => undefined;
  b.env.notificationAnswer = (n) => (n.message.includes('Clear the recorded activity') ? 'Clear' : undefined);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'dashboardModel.ts'), 'utf8');
  const commands = [...src.split('export type DashboardCommand')[1].split(';')[0].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  assert.equal(commands.length, 15);
  const expectations: Record<string, () => void> = {
    refresh: () => assert.ok(b.fetchCalls.length >= 2),
    signIn: () => undefined,
    showLog: () => assert.ok(b.env.logs.includes('[show]')),
    openSettings: () => assert.ok(b.env.executed.some((e) => e.id === 'workbench.action.openSettings')),
    openBilling: () => assert.ok(b.env.externalUrls.includes('https://github.com/settings/billing')),
    manageCopilot: () => assert.ok(b.env.externalUrls.includes('https://github.com/settings/copilot')),
    openChat: () => assert.ok(b.env.executed.some((e) => e.id === 'workbench.action.chat.open')),
    snooze: () => assert.ok(dash.model().settings.snoozedUntil > NOW),
    unsnooze: () => assert.equal(dash.model().settings.snoozedUntil, undefined),
    openWalkthrough: () =>
      assert.deepEqual(b.env.executed.find((e) => e.id === 'workbench.action.openWalkthrough')?.args, [
        'm3-13.copilot-contingent-watcher#contingentWatcher.gettingStarted',
        false,
      ]),
    configureBillingToken: () => assert.ok(b.env.notifications.some((n) => /fine-grained GitHub token/.test(n.message))),
    clearBillingToken: () => assert.equal(dash.model().models.state, 'notConfigured'),
    clearActivity: () => assert.ok(b.env.notifications.some((n) => /Clear the recorded activity/.test(n.message))),
    btw: () => assert.ok(b.env.webviewPanels.length >= 1),
    snoozeCompletions: () => undefined,
  };
  for (const c of commands) {
    await dash.send({ type: 'command', command: c });
    assert.ok(expectations[c], `expectation for ${c}`);
    expectations[c]();
  }
  // The walkthrough id exists in the manifest.
  assert.ok(PKG.contributes.walkthroughs.some((w: any) => w.id === 'contingentWatcher.gettingStarted'));
  // Unknown commands from the webview are ignored.
  const n = b.env.executed.length;
  await dash.send({ type: 'command', command: 'askSparsam' });
  await dash.send({ type: 'command', command: 'constructor' });
  assert.equal(b.env.executed.length, n);
  // No error notifications from any of it.
  assert.deepEqual(b.env.notifications.filter((x) => x.level === 'error'), []);
});

test('dashboard: enterprise users get links to their own host', async (t) => {
  const b = await boot(t, { config: { 'github-enterprise.uri': 'https://acme.ghe.com/', 'contingentWatcher.auth.provider': 'github-enterprise' } });
  await b.dashboard().send({ type: 'command', command: 'openBilling' });
  assert.deepEqual(b.env.externalUrls, ['https://acme.ghe.com/settings/billing']);
});

test('config: every contingentWatcher.* key read by the code exists in package.json', async (t) => {
  const b = await boot(t);
  const dash = b.dashboard();
  await dash.send({ type: 'command', command: 'btw' });
  assert.deepEqual([...b.env.unknownConfigReads], []);
});

test('btw window: ask, clear, copy, openSettings messages are handled', async (t) => {
  const b = await boot(t);
  await b.env.commands.get('contingentWatcher.btw')!();
  const panel = b.env.webviewPanels[0];
  panel.webview.send({ type: 'ready' });
  await tick();
  const init = panel.webview.posted.find((m: any) => m.type === 'init');
  assert.ok(init, 'init posted');
  assert.equal(init.strings.send, 'Send');
  assert.deepEqual(init.focus, { prefill: undefined });
  panel.webview.send({ type: 'ask', question: 'what is 2+2?' });
  for (let i = 0; i < 20; i++) {
    await tick();
  }
  const cards = panel.webview.posted.filter((m: any) => m.type === 'card').map((m: any) => m.card);
  assert.ok(cards.length >= 1);
  assert.equal(cards[0].question, 'what is 2+2?');
  // No models in the fake → finished with an explanation, not stuck in "thinking".
  assert.notEqual(cards.at(-1).status, 'thinking');
  panel.webview.send({ type: 'clear' });
  await tick();
  assert.ok(panel.webview.posted.some((m: any) => m.type === 'clear'));
  panel.webview.send({ type: 'openSettings' });
  await tick();
  assert.deepEqual(b.env.executed.find((e) => e.id === 'workbench.action.openSettings')?.args, ['contingentWatcher.chat.preferredModels']);
  await b.env.commands.get('contingentWatcher.btw.show')!();
  assert.equal(panel.reveals, 1);
});

// ------------------------------------------------------------------ refresh behaviour

test('manual refresh: spinner in status bar and model.refreshing for >= 600 ms, then cleared', async (t) => {
  const b = await boot(t);
  assert.equal(b.dashboard().model().refreshing, false);
  const p = b.env.commands.get('contingentWatcher.refresh')!();
  await tick();
  assert.match(b.item().text, /\$\(sync~spin\)$/, 'spinner while refreshing');
  assert.equal(b.dashboard().model().refreshing, true);
  const started = performance.now();
  await p;
  assert.ok(performance.now() - started >= 550, 'spinner visible at least ~600 ms');
  assert.equal(b.item().text, '$(contingent-level-2) 120');
  assert.equal(b.dashboard().model().refreshing, false);
  // Dashboard refresh button goes the same way.
  const dash = b.dashboard();
  const before = b.fetchCalls.length;
  await dash.send({ type: 'command', command: 'refresh' });
  assert.ok(dash.view.webview.posted.some((m: any) => m.type === 'model' && m.model.refreshing === true));
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(dash.model().refreshing, false);
  assert.equal(b.fetchCalls.length, before + 1);
  // A failing manual refresh also clears the spinner.
  b.setBody(() => {
    throw new TypeError('fetch failed');
  });
  await b.env.commands.get('contingentWatcher.refresh')!();
  assert.equal(b.item().text, '$(contingent-level-2) 120 $(history)');
  assert.equal(b.dashboard().model().refreshing, false);
});

test('interval: refreshes once refreshIntervalMinutes elapsed, also without window focus', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW });
  mocked.add(t);
  const b = await boot(t, { config: { 'contingentWatcher.refreshIntervalMinutes': 5 } });
  assert.equal(b.fetchCalls.length, 1);
  b.env.windowState.focused = false;
  for (let m = 1; m <= 4; m++) {
    t.mock.timers.tick(60_000);
    await settle(b.env);
  }
  assert.equal(b.fetchCalls.length, 1, 'not before 5 minutes');
  t.mock.timers.tick(60_000);
  await settle(b.env);
  assert.equal(b.fetchCalls.length, 2, 'after 5 minutes, unfocused');
  // Changing the interval reschedules; 2 min later it refreshes again.
  await b.env.vscode.workspace.getConfiguration('contingentWatcher').update('refreshIntervalMinutes', 2, 1);
  t.mock.timers.tick(60_000);
  await settle(b.env);
  assert.equal(b.fetchCalls.length, 2);
  t.mock.timers.tick(60_000);
  await settle(b.env);
  assert.equal(b.fetchCalls.length, 3);
});

test(
  'i18n: status bar numbers follow the VS Code display language like the dashboard does',
  { todo: 'BUG: format.ts fmt() uses toLocaleString() without vscode.env.language → "1,300" in the German status bar/tooltip, "1.300" in the dashboard' },
  async (t) => {
    const b = await boot(t, { locale: 'de', handler: () => json(BODIES.credits(1300)) });
    assert.equal(b.item().text, '$(contingent-level-2) 1.300');
  },
);

test(
  'TZ: month review labels the November cycle "November 2026" also west of UTC',
  { todo: 'BUG: extension.ts reviewSection label() formats 1 Nov 00:00Z in local time → "October 2026" in America/*' },
  async (t) => {
    const prev = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    t.after(() => (prev === undefined ? delete process.env.TZ : (process.env.TZ = prev)));
    const b = await boot(t);
    assert.equal(b.dashboard().model().review.cycles[0].label, 'November 2026');
  },
);

test('month review label is "November 2026" in UTC/Europe', async (t) => {
  const b = await boot(t);
  if (new Date(Date.UTC(2026, 10, 1)).getDate() === 1) {
    assert.equal(b.dashboard().model().review.cycles[0].label, 'November 2026');
  }
});
