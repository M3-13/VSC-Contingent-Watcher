/**
 * QA: independent reference calculation for the forecast / metrics / cycle /
 * surplus maths. The reference below is written from the documented meaning
 * of each value (README, core/types.ts, core/dashboardModel.ts) and does not
 * reuse any src/core function. Budget days are integrated hour by hour
 * instead of day by day, the usage curve is evaluated analytically and the
 * exhaustion date is found by walking hour segments.
 *
 * Every scenario runs in three time zones (process.env.TZ is switched at
 * runtime; Node re-reads it), because budget days and daily buckets use
 * local days while cycle start and reset are UTC instants.
 *
 * Updated with the QA fixes (qa-bugs.test.ts): work days are LOCAL days
 * (formerly UTC days), and the pace is day-granular: today counts as a full
 * budget day for expected usage, averages and the recent burn rate (last 7
 * whole local days), the projection only covers the budget days after
 * today, an exhaustion date needs a shortfall of at least half a budget day,
 * and "ahead"/"critical" need one completed budget day. The old reference
 * encoded the buggy definitions (24 h pace from the first history point).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeForecast } from '../core/forecast';
import { computeMetrics } from '../core/metrics';
import { summarizeCycle } from '../core/cycles';
import { expectedSurplus } from '../core/surplus';
import { HistoryPoint, QuotaSnapshot } from '../core/types';

const H = 3_600_000;
const D = 24 * H;
const TZS = ['UTC', 'Europe/Berlin', 'America/Los_Angeles'];

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

// ------------------------------------------------------------------ reference

function localWork(t: number, wd: readonly number[]): boolean {
  return wd.length === 0 || wd.includes(new Date(t).getDay());
}

/** Local midnight `offset` days after the local day of t. */
function localMidnight(t: number, offset = 0): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
}

/**
 * Work time in [from, to) in days, integrated over UTC hour segments (local
 * day boundaries fall on whole UTC hours in the tested time zones).
 */
function refBudgetDays(from: number, to: number, wd: readonly number[]): number {
  let ms = 0;
  for (let t = from; t < to; ) {
    const end = Math.min(to, (Math.floor(t / H) + 1) * H);
    if (localWork(t, wd)) {
      ms += end - t;
    }
    t = end;
  }
  return ms / D;
}

/** Instant at which `days` budget days have passed after t (walks hour segments). */
function refAddBudgetDays(t: number, days: number, wd: readonly number[]): number {
  let need = days * D;
  let cur = t;
  for (let i = 0; i < 24 * 400; i++) {
    const end = (Math.floor(cur / H) + 1) * H;
    if (localWork(cur, wd)) {
      if (need <= end - cur) {
        const e = cur + need;
        // Ending exactly at the end of a work day stays on that day.
        return e === localMidnight(e) ? e - 1 : e;
      }
      need -= end - cur;
    }
    cur = end;
  }
  return cur;
}

function refCycleStart(resetIso: string): number {
  const r = new Date(resetIso);
  // One calendar month earlier, same day, 00:00 UTC (GitHub resets on the 1st).
  return Date.UTC(r.getUTCFullYear(), r.getUTCMonth() - 1, r.getUTCDate());
}

interface RefIn {
  snap: QuotaSnapshot;
  history: HistoryPoint[];
  wd: number[];
  reserve: number;
  now: number;
}

function refCurve(i: RefIn) {
  const start = refCycleStart(i.snap.resetDate);
  const pts: HistoryPoint[] = [{ t: start, used: 0 }];
  for (const p of [...i.history].sort((a, b) => a.t - b.t)) {
    if (p.t > start && p.t <= i.now) {
      pts.push({ ...p });
    }
  }
  pts.push({ t: i.now, used: i.snap.used });
  let hi = 0;
  for (const p of pts) {
    hi = Math.max(hi, p.used);
    p.used = hi;
  }
  const firstReal = pts.length > 2 ? pts[1].t : i.now;
  const at = (t: number): number => {
    if (t <= start) {
      return 0;
    }
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      if (t <= b.t) {
        return b.t === a.t ? b.used : a.used + ((b.used - a.used) * (t - a.t)) / (b.t - a.t);
      }
    }
    return pts[pts.length - 1].used;
  };
  /** Exact first instant the curve reaches `level`. */
  const reach = (level: number): number | undefined => {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      if (b.used >= level) {
        if (a.used >= level) {
          return a.t;
        }
        return a.t + ((level - a.used) / (b.used - a.used)) * (b.t - a.t);
      }
    }
    return undefined;
  };
  return { start, firstReal, at, reach };
}

function refForecast(i: RefIn) {
  const { snap, wd, now } = i;
  const start = refCycleStart(snap.resetDate);
  const reset = Date.parse(snap.resetDate);
  const total = refBudgetDays(start, reset, wd);
  const elapsed = refBudgetDays(start, Math.min(now, reset), wd);
  const daysLeft = refBudgetDays(Math.max(now, start), reset, wd);
  const cycleElapsed = Math.min(1, elapsed / total);
  // Day-granular pace: today counts as a full budget day.
  const todayEnd = Math.min(reset, localMidnight(now, 1));
  const paceElapsed = refBudgetDays(start, todayEnd, wd);
  const completed = refBudgetDays(start, Math.min(reset, localMidnight(now)), wd);
  const after = refBudgetDays(Math.max(todayEnd, start), reset, wd);
  const expected = snap.entitlement * Math.min(1, paceElapsed / total);
  const paceRatio = expected > 0 ? snap.used / expected : snap.used > 0 ? Infinity : 0;
  const spendable = Math.max(0, snap.remaining - i.reserve);
  const dailyBudget = daysLeft > 0 ? spendable / Math.max(1, daysLeft) : 0;
  // Recent burn: usage since local midnight 6 days before today (or cycle
  // start, where usage is 0), per budget day of those whole local days.
  const ws = Math.max(start, localMidnight(now, -6));
  let base: number | undefined;
  if (ws <= start) {
    base = 0;
  } else {
    const before = i.history.filter((p) => p.t <= ws && p.t <= now).sort((a, b) => b.t - a.t)[0];
    const afterPt = i.history.filter((p) => p.t > ws && p.t <= now).sort((a, b) => a.t - b.t)[0];
    if (before) {
      base = afterPt ? before.used + ((afterPt.used - before.used) * (ws - before.t)) / (afterPt.t - before.t) : before.used;
    }
  }
  let burn: number | undefined;
  const winDays = refBudgetDays(ws, todayEnd, wd);
  if (base !== undefined && winDays >= 0.5) {
    burn = Math.max(0, snap.used - base) / winDays;
  }
  burn ??= paceElapsed >= 1 - 1e-9 ? snap.used / paceElapsed : 0;
  const projectedUsed = snap.used + burn * after;
  const exhaustion =
    burn > 0 && snap.remaining > 0 && snap.remaining / burn < after - 0.5 ? refAddBudgetDays(now, snap.remaining / burn, wd) : undefined;
  const enough = completed >= 1 - 1e-9;
  let status: string;
  if (snap.unlimited) {
    status = 'unlimited';
  } else if (snap.remaining <= 0) {
    status = 'exhausted';
  } else if (enough && exhaustion !== undefined && exhaustion < reset - 3 * D) {
    status = 'critical';
  } else if (enough && paceRatio > 1.15 && snap.used >= 5) {
    status = 'ahead';
  } else {
    status = 'onTrack';
  }
  return { total, elapsed, paceElapsed, daysLeft, cycleElapsed, paceRatio, dailyBudget, burnRate: burn, projectedUsed, exhaustion, status };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function refMetrics(i: RefIn) {
  const { snap, wd, now } = i;
  const c = refCurve(i);
  const reset = Date.parse(snap.resetDate);
  const f = refForecast(i);
  const planPerDay = snap.entitlement / f.total;
  const s0 = new Date(c.start);
  const todayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
  const today = Math.max(0, snap.used - c.at(Math.max(c.start, todayStart)));
  const last7Days = Math.max(0, snap.used - c.at(Math.max(c.start, now - 7 * D)));
  const cycleAverage = snap.used / Math.max(1, f.paceElapsed);
  const buffer = snap.entitlement * Math.min(1, f.elapsed / f.total) - snap.used;
  const bufferDays = planPerDay > 0 ? buffer / planPerDay : 0;
  const daily: { date: string; used: number; offDay: boolean; estimated: boolean; exhausted: boolean }[] = [];
  for (let k = 0; ; k++) {
    const dayStart = new Date(s0.getFullYear(), s0.getMonth(), s0.getDate() + k).getTime();
    if (dayStart > now) {
      break;
    }
    const next = new Date(s0.getFullYear(), s0.getMonth(), s0.getDate() + k + 1).getTime();
    const from = Math.max(dayStart, c.start);
    const to = Math.min(next, now);
    const ld = new Date(dayStart);
    daily.push({
      date: `${ld.getFullYear()}-${pad(ld.getMonth() + 1)}-${pad(ld.getDate())}`,
      used: Math.max(0, c.at(to) - c.at(from)),
      offDay: wd.length > 0 && !wd.includes(ld.getDay()),
      estimated: to <= c.firstReal,
      exhausted: snap.entitlement > 0 && c.at(from) >= snap.entitlement - 1e-6,
    });
  }
  let streak = 0;
  for (let k = daily.length - 2; k >= 0; k--) {
    const d = daily[k];
    if (d.estimated || d.exhausted) {
      break;
    }
    if (d.offDay && d.used === 0) {
      continue;
    }
    if (d.used > planPerDay + 1e-9) {
      break;
    }
    streak++;
  }
  let demand: { estimate: number; overBy: number; exhaustedOn?: number } | undefined;
  if (!snap.unlimited && snap.entitlement > 0) {
    let rate: number | undefined;
    let exhaustedOn: number | undefined;
    if (snap.overageCount > 0) {
      rate = f.paceElapsed >= 1 - 1e-9 ? (snap.used + snap.overageCount) / f.paceElapsed : undefined;
    } else if (snap.remaining <= 0) {
      exhaustedOn = c.reach(snap.entitlement - 1e-6);
      const days = exhaustedOn !== undefined ? refBudgetDays(c.start, exhaustedOn, wd) : 0;
      rate = days >= 0.5 ? snap.entitlement / days : undefined;
    } else {
      rate = f.paceElapsed >= 1 - 1e-9 ? snap.used / f.paceElapsed : undefined;
    }
    if (rate !== undefined) {
      const estimate = Math.max(snap.used, rate * f.total);
      demand = { estimate, overBy: estimate - snap.entitlement, exhaustedOn };
    }
  }
  void reset;
  return { today, last7Days, cycleAverage, buffer, bufferDays, streak, daily, planPerDay, demand };
}

// ------------------------------------------------------------------ scenarios

const NOV_RESET = '2026-12-01T00:00:00.000Z';
const FEB_RESET = '2027-03-01T00:00:00.000Z';

function mkSnap(resetDate: string, entitlement: number, used: number, now: number, over: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  const u = Math.min(used, entitlement);
  return {
    entitlement,
    used: u,
    remaining: Math.max(0, entitlement - u),
    unlimited: false,
    overagePermitted: false,
    overageCount: 0,
    resetDate,
    unit: 'requests',
    quotaId: 'premium_interactions',
    fetchedAt: now,
    ...over,
  };
}

/** True usage: `perHour` during 09:00–17:00 UTC on UTC work days, capped. */
function trueUsage(start: number, t: number, wd: number[], perHour: number, cap: number): number {
  let u = 0;
  for (let h = start; h < t; h += H) {
    const d = new Date(h);
    const hr = d.getUTCHours();
    if (hr >= 9 && hr < 17 && (wd.length === 0 || wd.includes(d.getUTCDay()))) {
      u += perHour * (Math.min(t, h + H) - h) / H;
    }
  }
  return Math.min(cap, u);
}

type HistKind = 'none' | 'hourly' | 'daily17' | 'lateInstall';

function mkHistory(kind: HistKind, start: number, now: number, f: (t: number) => number): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  if (kind === 'none') {
    return out;
  }
  if (kind === 'hourly') {
    for (let t = start + H; t <= now; t += H) {
      out.push({ t, used: f(t) });
    }
  } else if (kind === 'daily17') {
    for (let t = start + 17 * H; t <= now; t += D) {
      out.push({ t, used: f(t) });
    }
  } else {
    // Installed mid-cycle: points every 3h from 10 days before now.
    for (let t = Math.max(start + H, now - 10 * D); t <= now; t += 3 * H) {
      out.push({ t, used: f(t) });
    }
  }
  if (out.length === 0 || out[out.length - 1].t !== now) {
    out.push({ t: now, used: f(now) });
  }
  return out;
}

const WORKDAY_SETS: Record<string, number[]> = {
  'Mon-Fri': [1, 2, 3, 4, 5],
  'Mon/Tue/Thu': [1, 2, 4],
  'Sat only': [6],
  'all 7': [0, 1, 2, 3, 4, 5, 6],
};

const NOWS: Record<string, [string, number][]> = {
  [NOV_RESET]: [
    ['Nov cycle start', Date.UTC(2026, 10, 1, 0, 0)],
    ['Sun Nov 1 13:00 (day off)', Date.UTC(2026, 10, 1, 13)],
    ['Mon Nov 2 09:30', Date.UTC(2026, 10, 2, 9, 30)],
    ['Mon Nov 16 00:00 (mid)', Date.UTC(2026, 10, 16)],
    ['Wed Nov 18 15:45', Date.UTC(2026, 10, 18, 15, 45)],
    ['Wed Nov 25 12:00 (today)', Date.UTC(2026, 10, 25, 12)],
    ['Thu Nov 26 12:00', Date.UTC(2026, 10, 26, 12)],
    ['Sat Nov 28 10:00', Date.UTC(2026, 10, 28, 10)],
    ['Mon Nov 30 23:00 (last day)', Date.UTC(2026, 10, 30, 23)],
  ],
  [FEB_RESET]: [
    ['Feb 1 00:00', Date.UTC(2027, 1, 1)],
    ['Sun Feb 14 12:00', Date.UTC(2027, 1, 14, 12)],
    ['Mon Feb 15 08:00', Date.UTC(2027, 1, 15, 8)],
    ['Sun Feb 28 18:00 (last day)', Date.UTC(2027, 1, 28, 18)],
  ],
};

interface Scenario {
  name: string;
  input: RefIn;
}

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const [reset, nows] of Object.entries(NOWS)) {
    const start = refCycleStart(reset);
    for (const [wdName, wd] of Object.entries(WORKDAY_SETS)) {
      for (const [nowName, now] of nows) {
        // perHour: 1.5/h → ~12/work day; 8/h → exhausts 300 mid-cycle.
        for (const perHour of [0, 1.5, 8]) {
          for (const hist of ['none', 'hourly', 'daily17', 'lateInstall'] as HistKind[]) {
            for (const reserve of [0, 50]) {
              const ent = 300;
              const f = (t: number) => trueUsage(start, t, wd, perHour, ent);
              const used = f(now);
              const snap = mkSnap(reset, ent, used, now);
              out.push({
                name: `${reset.slice(0, 7)} ${wdName} @ ${nowName} perHour=${perHour} hist=${hist} reserve=${reserve}`,
                input: { snap, history: mkHistory(hist, start, now, f), wd, reserve, now },
              });
            }
          }
        }
      }
    }
  }
  // Credits, overage, unlimited variants (Mon/Tue/Thu, mid-month).
  const now = Date.UTC(2026, 10, 18, 15, 45);
  const start = refCycleStart(NOV_RESET);
  const wd = [1, 2, 4];
  const f = (t: number) => trueUsage(start, t, wd, 6, 1000);
  const hist = mkHistory('hourly', start, now, f);
  out.push({ name: 'credits 1000', input: { snap: mkSnap(NOV_RESET, 1000, f(now), now, { unit: 'credits', quotaId: 'ai_credits' }), history: hist, wd, reserve: 0, now } });
  out.push({
    name: 'overage',
    input: { snap: mkSnap(NOV_RESET, 300, 300, now, { overagePermitted: true, overageCount: 42 }), history: hist.map((p) => ({ t: p.t, used: Math.min(300, p.used) })), wd, reserve: 0, now },
  });
  out.push({ name: 'unlimited', input: { snap: mkSnap(NOV_RESET, 0, 0, now, { unlimited: true }), history: [], wd, reserve: 0, now } });
  return out;
}

function close(actual: number | undefined, expected: number | undefined, what: string, eps = 1e-6): void {
  if (expected === undefined || actual === undefined) {
    assert.equal(actual, expected, what);
    return;
  }
  if (!Number.isFinite(expected)) {
    assert.equal(actual, expected, what);
    return;
  }
  const tol = eps * Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: got ${actual}, expected ${expected}`);
}

function checkScenario(s: Scenario, tz: string): void {
  const { snap, history, wd, reserve, now } = s.input;
  const label = `[${tz}] ${s.name}`;
  const opts = { workDays: wd, reserve };
  const fc = computeForecast(snap, history, opts, now);
  const rf = refForecast(s.input);
  close(fc.daysLeft, rf.daysLeft, `${label} daysLeft`);
  close(fc.cycleElapsed, rf.cycleElapsed, `${label} cycleElapsed`);
  close(fc.paceRatio, rf.paceRatio, `${label} paceRatio`);
  close(fc.dailyBudget, rf.dailyBudget, `${label} dailyBudget`);
  close(fc.burnRate, rf.burnRate, `${label} burnRate`);
  close(fc.projectedUsed, rf.projectedUsed, `${label} projectedUsed`);
  close(fc.exhaustionDate?.getTime(), rf.exhaustion, `${label} exhaustionDate`, 1e-9);
  if (!snap.unlimited) {
    assert.equal(fc.status, rf.status, `${label} status`);
  }
  close(fc.usedPercent, snap.entitlement > 0 ? (snap.used / snap.entitlement) * 100 : 0, `${label} usedPercent`);

  // Semantic invariants (independent of the formulas above).
  if (fc.exhaustionDate) {
    const e = fc.exhaustionDate.getTime();
    assert.ok(e > now && e <= Date.parse(snap.resetDate), `${label} exhaustion within cycle`);
    // Lands inside a (local) work day: the instant just before it is work time.
    assert.ok(localWork(e - 1, wd), `${label} exhaustion on a work day`);
    // … and its displayed local date is a work day.
    assert.ok(localWork(e, wd), `${label} exhaustion date is a work day`);
  }
  if (fc.daysLeft >= 1) {
    close(fc.dailyBudget * fc.daysLeft, Math.max(0, snap.remaining - reserve), `${label} budget*daysLeft = spendable`);
  }
  assert.ok(fc.dailyBudget >= 0 && fc.daysLeft >= 0, `${label} non-negative`);

  const m = computeMetrics(snap, history, opts, now);
  const rm = refMetrics(s.input);
  close(m.today, rm.today, `${label} today`);
  close(m.last7Days, rm.last7Days, `${label} last7Days`);
  close(m.cycleAverage, rm.cycleAverage, `${label} cycleAverage`);
  close(m.buffer, rm.buffer, `${label} buffer`);
  close(m.bufferDays, rm.bufferDays, `${label} bufferDays`);
  close(m.planPerDay, rm.planPerDay, `${label} planPerDay`);
  assert.equal(m.streakDays, rm.streak, `${label} streak`);
  assert.equal(m.daily.length, rm.daily.length, `${label} daily length`);
  m.daily.forEach((d, k) => {
    const r = rm.daily[k];
    assert.equal(d.date, r.date, `${label} daily[${k}].date`);
    close(d.used, r.used, `${label} daily[${k}].used`);
    assert.equal(d.offDay, r.offDay, `${label} daily[${k}].offDay`);
    assert.equal(d.estimated, r.estimated, `${label} daily[${k}].estimated`);
    assert.equal(d.exhausted, r.exhausted, `${label} daily[${k}].exhausted`);
  });
  // Buckets add up to the used value; today is the last bucket.
  close(
    m.daily.reduce((a, d) => a + d.used, 0),
    snap.used,
    `${label} sum(daily) = used`,
  );
  close(m.daily[m.daily.length - 1].used, m.today, `${label} today = last bucket`);
  // Local dates are consecutive.
  for (let k = 1; k < m.daily.length; k++) {
    const [y0, m0, d0] = m.daily[k - 1].date.split('-').map(Number);
    const [y1, m1, d1] = m.daily[k].date.split('-').map(Number);
    const diff = Math.round((new Date(y1, m1 - 1, d1).getTime() - new Date(y0, m0 - 1, d0).getTime()) / D);
    assert.equal(diff, 1, `${label} consecutive dates ${m.daily[k - 1].date} → ${m.daily[k].date}`);
  }
  if (rm.demand === undefined) {
    assert.equal(m.demand, undefined, `${label} demand undefined`);
  } else {
    assert.ok(m.demand, `${label} demand defined`);
    // exhaustedOn comes from a binary search with 60 s resolution.
    close(m.demand!.estimate, rm.demand.estimate, `${label} demand.estimate`, 1e-3);
    close(m.demand!.overBy, rm.demand.overBy, `${label} demand.overBy`, 1e-3);
    if (rm.demand.exhaustedOn !== undefined) {
      assert.ok(m.demand!.exhaustedOn, `${label} exhaustedOn set`);
      const got = Date.parse(m.demand!.exhaustedOn!);
      assert.ok(Math.abs(got - rm.demand.exhaustedOn) <= 61_000, `${label} exhaustedOn ${m.demand!.exhaustedOn}`);
    } else {
      assert.equal(m.demand!.exhaustedOn, undefined, `${label} exhaustedOn undefined`);
    }
  }

  // Surplus: last 7 days before reset and >= max(10, 10 %) expected unused.
  const sur = expectedSurplus(snap, fc, now);
  const untilReset = Date.parse(snap.resetDate) - now;
  const unused = snap.entitlement - rf.projectedUsed;
  const expSur =
    snap.unlimited || snap.entitlement <= 0 || untilReset <= 0 || untilReset > 7 * D || unused < Math.max(10, snap.entitlement * 0.1)
      ? undefined
      : Math.floor(unused);
  assert.equal(sur, expSur, `${label} surplus`);

  // Cycle summary (archived when the cycle ends).
  const sum = summarizeCycle(snap, history, opts, now);
  const real = rm.daily.filter((d) => !d.estimated);
  const active = real.filter((d) => d.used >= 0.5);
  assert.equal(sum.activeDays, active.length, `${label} cycle.activeDays`);
  close(sum.avgPerActiveDay, active.length ? active.reduce((a, d) => a + d.used, 0) / active.length : 0, `${label} cycle.avg`);
  if (rm.demand) {
    // Rounded estimate; exhaustedOn has 60 s resolution, so allow ±1.
    assert.ok(sum.demand !== undefined && Math.abs(sum.demand - rm.demand.estimate) <= 1, `${label} cycle.demand ${sum.demand}`);
  } else {
    assert.equal(sum.demand, undefined, `${label} cycle.demand`);
  }
}

for (const tz of TZS) {
  test(`reference matrix matches core maths (TZ=${tz})`, () => {
    withTz(tz, () => {
      const list = scenarios();
      assert.ok(list.length > 1000);
      const failures: string[] = [];
      for (const s of list) {
        try {
          checkScenario(s, tz);
        } catch (e) {
          failures.push(e instanceof Error ? e.message.split('\n')[0] : String(e));
        }
      }
      assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${list.length} scenarios differ`);
    });
  });
}

// ------------------------------------------------------------- hand-computed

test('hand-computed: Nov 2026 has 21 Mon–Fri, 13 Mon/Tue/Thu, 4 Sat, 30 calendar budget days', () => {
  // Hand-computed for UTC days (work days are local days since the QA fix).
  withTz('UTC', () => {
    const now = Date.UTC(2026, 10, 1);
    for (const [wd, n] of [
      [[1, 2, 3, 4, 5], 21],
      [[1, 2, 4], 13],
      [[6], 4],
      [[0, 1, 2, 3, 4, 5, 6], 30],
      [[], 30],
    ] as [number[], number][]) {
      const f = computeForecast(mkSnap(NOV_RESET, 300, 0, now), [], { workDays: wd, reserve: 0 }, now);
      close(f.daysLeft, n, `daysLeft ${wd}`);
      close(f.dailyBudget, 300 / n, `dailyBudget ${wd}`);
    }
  });
});

test('hand-computed: Feb 2027 (28 days) has 20 Mon–Fri, 12 Mon/Tue/Thu, 4 Sat, 28 days', () => {
  const now = Date.UTC(2027, 1, 1);
  for (const [wd, n] of [
    [[1, 2, 3, 4, 5], 20],
    [[1, 2, 4], 12],
    [[6], 4],
    [[0, 1, 2, 3, 4, 5, 6], 28],
  ] as [number[], number][]) {
    const f = computeForecast(mkSnap(FEB_RESET, 300, 0, now), [], { workDays: wd, reserve: 0 }, now);
    close(f.daysLeft, n, `daysLeft ${wd}`);
  }
});

test('hand-computed: Wed 25 Nov 12:00Z, Mon/Tue/Thu, 150/300 used, reserve 50', () => {
  // Hand-computed for UTC days (work days are local days since the QA fix).
  withTz('UTC', () => {
    const now = Date.UTC(2026, 10, 25, 12);
    const f = computeForecast(mkSnap(NOV_RESET, 300, 150, now), [], { workDays: [1, 2, 4], reserve: 50 }, now);
    // Elapsed work days: 2,3,5,9,10,12,16,17,19,23,24 = 11 of 13; left: Thu 26, Mon 30.
    close(f.cycleElapsed, 11 / 13, 'cycleElapsed');
    close(f.daysLeft, 2, 'daysLeft');
    close(f.dailyBudget, (150 - 50) / 2, 'dailyBudget');
    close(f.burnRate, 150 / 11, 'burnRate (cycle average)');
    close(f.projectedUsed, 150 + (150 / 11) * 2, 'projectedUsed');
    close(f.paceRatio, 150 / (300 * (11 / 13)), 'paceRatio');
    assert.equal(f.status, 'onTrack');
    assert.equal(f.exhaustionDate, undefined);
  });
});

test('hand-computed: Sat-only worker, Sat 28 Nov 10:00Z: today counts 14/24, nothing else left', () => {
  // Hand-computed for UTC days (work days are local days since the QA fix).
  withTz('UTC', () => {
    const now = Date.UTC(2026, 10, 28, 10);
    const f = computeForecast(mkSnap(NOV_RESET, 300, 200, now), [], { workDays: [6], reserve: 0 }, now);
    close(f.daysLeft, 14 / 24, 'daysLeft');
    // daysLeft < 1: the rest is spendable today.
    close(f.dailyBudget, 100, 'dailyBudget');
    close(f.cycleElapsed, (3 + 10 / 24) / 4, 'cycleElapsed');
  });
});

test('hand-computed: last day 23:00Z, all days: 1/24 day left, budget = everything', () => {
  const now = Date.UTC(2026, 10, 30, 23);
  const f = computeForecast(mkSnap(NOV_RESET, 300, 290, now), [], { workDays: [0, 1, 2, 3, 4, 5, 6], reserve: 0 }, now);
  close(f.daysLeft, 1 / 24, 'daysLeft');
  close(f.dailyBudget, 10, 'dailyBudget');
});

test('hand-computed: exhausted mid-month ends streak, demand from pace until empty', () => {
  // All days, 20/day from Nov 1 → empty after 15 days (Nov 16 00:00Z).
  const start = Date.UTC(2026, 10, 1);
  const now = Date.UTC(2026, 10, 20, 12);
  const history: HistoryPoint[] = [];
  for (let t = start + 6 * H; t <= now; t += 6 * H) {
    history.push({ t, used: Math.min(300, ((t - start) / D) * 20) });
  }
  const snap = mkSnap(NOV_RESET, 300, 300, now);
  withTz('UTC', () => {
    const m = computeMetrics(snap, history, { workDays: [], reserve: 0 }, now);
    assert.equal(m.streakDays, 0, 'streak ends when exhausted');
    assert.ok(m.demand);
    close(m.demand!.estimate, 20 * 30, 'demand = 20/day × 30', 1e-3);
    assert.equal(m.demand!.exhaustedOn?.slice(0, 13), '2026-11-16T00');
    const idx = m.daily.findIndex((d) => d.date === '2026-11-16');
    assert.equal(m.daily[idx].exhausted, true);
    assert.equal(m.daily[idx - 1].exhausted, false);
    const f = computeForecast(snap, history, { workDays: [], reserve: 0 }, now);
    assert.equal(f.status, 'exhausted');
    assert.equal(f.dailyBudget, 0);
    assert.equal(f.exhaustionDate, undefined);
  });
});

test('hand-computed: days off without usage do not break the streak (Mon/Tue/Thu)', () => {
  withTz('UTC', () => {
    // 5 per work day at 12:00 (plan is 300/13 ≈ 23), nothing on days off.
    const start = Date.UTC(2026, 10, 1);
    const now = Date.UTC(2026, 10, 25, 12);
    const wd = [1, 2, 4];
    const history: HistoryPoint[] = [];
    let used = 0;
    for (let t = start; t <= now; t += D) {
      const day = new Date(t).getUTCDay();
      history.push({ t: t + 11 * H, used });
      if (wd.includes(day)) {
        used += 5;
      }
      history.push({ t: t + 13 * H, used });
    }
    const real = history.filter((p) => p.t <= now);
    const snap = mkSnap(NOV_RESET, 300, real[real.length - 1].used, now);
    const m = computeMetrics(snap, real, { workDays: wd, reserve: 0 }, now);
    // Nov 2 … Nov 24: 11 work days within plan; the 12 days off (no usage) are skipped.
    assert.equal(m.streakDays, 11);
  });
});
