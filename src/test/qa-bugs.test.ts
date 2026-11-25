/**
 * QA: regression tests for bugs found during testing (formerly marked `todo`
 * while the bugs existed). Each test asserts the expected behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBudgetDays, computeForecast } from '../core/forecast';
import { computeMetrics } from '../core/metrics';
import { HistoryPoint, QuotaSnapshot } from '../core/types';

const H = 3_600_000;
const D = 24 * H;

function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = prev;
    }
  }
}

function snap(used: number, now: number, ent = 300): QuotaSnapshot {
  return {
    entitlement: ent,
    used,
    remaining: Math.max(0, ent - used),
    unlimited: false,
    overagePermitted: false,
    overageCount: 0,
    resetDate: '2026-12-01T00:00:00.000Z',
    unit: 'requests',
    quotaId: 'premium_interactions',
    fetchedAt: now,
  };
}

const MTT = [1, 2, 4]; // Mon, Tue, Thu

test(
  'TZ: "empty on" date can fall on a local day off (Los Angeles, Mon/Tue/Thu)',
  () => {
    withTz('America/Los_Angeles', () => {
      // Tue 24 Nov 12:00 PST. 6 more budget hours until empty.
      const now = Date.UTC(2026, 10, 24, 20);
      const e = addBudgetDays(now, 6 / 24, MTT);
      // Actual: 2026-11-26T02:00Z = Wed 25 Nov 18:00 PST -> tooltip "empty on Nov 25" (a Wednesday, day off).
      assert.ok(MTT.includes(e.getDay()), `local weekday ${e.getDay()} (${e.toString()}) is not a work day`);
    });
  },
);

test(
  'TZ: a local work day evening counts nothing for today (Los Angeles, Thu 17:00)',
  () => {
    withTz('America/Los_Angeles', () => {
      const now = Date.UTC(2026, 10, 27, 1); // Thu 26 Nov 17:00 PST
      const opts = { workDays: MTT, reserve: 0 };
      const m = computeMetrics(snap(200, now), [], opts, now);
      const f = computeForecast(snap(200, now), [], opts, now);
      // Chart says today is a work day …
      assert.equal(m.daily[m.daily.length - 1].offDay, false);
      // … so the rest of today (7 h) plus Mon 30 until 16:00 PST (reset, as in the Sun 18:00 test
      // below) should be left = 23/24. Before the fix: exactly 1 (only Mon 30 UTC).
      // (Originally asserted `daysLeft > 1`, which counted Mon 30 as a full day and contradicted
      // the reset being an absolute instant, 1 Dec 00:00Z = Mon 30 16:00 PST.)
      assert.ok(Math.abs(f.daysLeft - (7 + 16) / 24) < 1e-6, `daysLeft ${f.daysLeft}`);
    });
  },
);

test(
  'TZ: a local day off counts as budget time (Los Angeles, Sun 18:00)',
  () => {
    withTz('America/Los_Angeles', () => {
      const now = Date.UTC(2026, 10, 23, 2); // Sun 22 Nov 18:00 PST
      const opts = { workDays: MTT, reserve: 0 };
      const m = computeMetrics(snap(200, now), [], opts, now);
      const f = computeForecast(snap(200, now), [], opts, now);
      assert.equal(m.daily[m.daily.length - 1].offDay, true, 'chart: today is a day off');
      // Work days left in local time: Mon 23, Tue 24, Thu 26 and Mon 30 until 16:00 PST (reset) = 3 + 16/24.
      // Actual 3.9167 (22 h of Monday UTC + Tue + Thu + Mon).
      assert.ok(Math.abs(f.daysLeft - (3 + 16 / 24)) < 1e-6, `daysLeft ${f.daysLeft}`);
    });
  },
);

test(
  'exhaustion exactly at the end of a work day is reported as the next (day off) date',
  () => {
    withTz('UTC', () => {
      // Mon 23 Nov 12:00Z, work days Mon/Wed, half a budget day left → empty at the end of Monday.
      const e = addBudgetDays(Date.UTC(2026, 10, 23, 12), 0.5, [1, 3]);
      // Actual: 2026-11-24T00:00Z → displayed as "Nov 24" (Tuesday, a day off).
      assert.equal(e.getUTCDate(), 23, e.toISOString());
    });
  },
);

/**
 * A user who spends exactly the plan (300 / 21 per Mon–Fri work day) during
 * office hours 09–17 UTC, VS Code open 08–18 and refreshed every 10 minutes.
 */
function onPlanUser(nowIso: string) {
  const ent = 300;
  const wd = [1, 2, 3, 4, 5];
  const plan = ent / 21;
  const start = Date.UTC(2026, 10, 1);
  const used = (t: number) => {
    let u = 0;
    for (let h = start; h < t; h += H) {
      const d = new Date(h);
      if (wd.includes(d.getUTCDay()) && d.getUTCHours() >= 9 && d.getUTCHours() < 17) {
        u += (plan / 8) * Math.min(1, (t - h) / H);
      }
    }
    return u;
  };
  const now = Date.parse(nowIso);
  const history: HistoryPoint[] = [];
  for (let t = start; t <= now; t += 10 * 60_000) {
    const d = new Date(t);
    if (wd.includes(d.getUTCDay()) && d.getUTCHours() >= 8 && d.getUTCHours() < 18) {
      const u = used(t);
      const last = history[history.length - 1];
      if (!last || last.used !== u || t - last.t > H) {
        history.push({ t, used: u });
      }
    }
  }
  history.push({ t: now, used: used(now) });
  return { s: snap(used(now), now, ent), history, opts: { workDays: wd, reserve: 0 }, now };
}

test(
  'pace: a user exactly on plan is not flagged "will run out" in the first week',
  () => {
    for (const nowIso of ['2026-11-03T17:00:00Z', '2026-11-04T17:00:00Z', '2026-11-06T17:00:00Z']) {
      const u = onPlanUser(nowIso);
      const f = computeForecast(u.s, u.history, u.opts, u.now);
      // Actual: status 'critical' with exhaustion 20–26 Nov, red status bar and a pace notification.
      assert.notEqual(f.status, 'critical', `${nowIso}: burnRate ${f.burnRate.toFixed(2)} vs plan ${(300 / 21).toFixed(2)}, empty ${f.exhaustionDate?.toISOString()}`);
    }
  },
);

test(
  'pace: a user exactly on plan sees no "empty on …" date mid-month',
  () => {
    const u = onPlanUser('2026-11-18T17:00:00Z');
    const f = computeForecast(u.s, u.history, u.opts, u.now);
    assert.equal(f.exhaustionDate, undefined, `projected ${f.projectedUsed.toFixed(1)}, empty ${f.exhaustionDate?.toISOString()}`);
  },
);

test(
  'pace: on plan on day one is not "Faster than planned"',
  () => {
    const u = onPlanUser('2026-11-02T17:00:00Z');
    const f = computeForecast(u.s, u.history, u.opts, u.now);
    assert.equal(f.status, 'onTrack', `paceRatio ${f.paceRatio.toFixed(2)}`);
  },
);

void D;

test(
  'TZ: pace warning is shown at most once per local day (Los Angeles)',
  async (t) => {
    const { State } = await import('../state');
    const mem = new Map<string, unknown>();
    const memento = {
      get: (k: string, d?: unknown) => (mem.has(k) ? mem.get(k) : d),
      update: async (k: string, v: unknown) => void mem.set(k, v),
      keys: () => [...mem.keys()],
    };
    await withTzAsync('America/Los_Angeles', async () => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 24, 23) }); // Tue 15:00 PST
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = new State(memento as any);
      await s.markPaceWarned();
      t.mock.timers.setTime(Date.UTC(2026, 10, 25, 1)); // Tue 17:00 PST, same local day
      assert.equal(s.paceWarnedToday(), true);
    });
  },
);

async function withTzAsync(tz: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = prev;
    }
  }
}
