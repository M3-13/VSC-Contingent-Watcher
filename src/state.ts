import * as vscode from 'vscode';
import { addCycle, CycleSummary, summarizeCycle } from './core/cycles';
import { compact } from './core/history';
import { cycleKey } from './core/thresholds';
import { HistoryPoint, QuotaSnapshot } from './core/types';

const K_HISTORY = 'history';
const K_LAST = 'lastSnapshot';
const K_NOTIFIED = 'notified';
const K_SNOOZE = 'snoozeUntil';
const K_PACE_DAY = 'paceWarnedDay';
const K_CYCLES = 'cycles';
const K_SURPLUS = 'surplusNotified';

interface NotifiedState {
  cycle: string;
  thresholds: number[];
}

/** Persists history and notification state in globalState (synced off). */
export class State {
  constructor(private readonly mem: vscode.Memento) {}

  get last(): QuotaSnapshot | undefined {
    return this.mem.get<QuotaSnapshot>(K_LAST);
  }

  get history(): HistoryPoint[] {
    return this.mem.get<HistoryPoint[]>(K_HISTORY, []);
  }

  /** Stores the snapshot; clears history when a new cycle has started. */
  async record(snap: QuotaSnapshot): Promise<void> {
    const prev = this.last;
    let history = this.history;
    const newCycle = prev && (cycleKey(prev.resetDate) !== cycleKey(snap.resetDate) || snap.used < prev.used);
    if (newCycle && prev) {
      // Archive the finished cycle before its history is dropped.
      const summary = summarizeCycle(prev, history, { workDays: [], reserve: 0 }, prev.fetchedAt);
      await this.mem.update(K_CYCLES, addCycle(this.cycles, summary));
      history = [];
    }
    const lastPt = history[history.length - 1];
    // Only store a point if usage changed or an hour passed: keeps state small.
    if (!lastPt || lastPt.used !== snap.used || snap.fetchedAt - lastPt.t > 3_600_000) {
      history.push({ t: snap.fetchedAt, used: snap.used });
    }
    history = compact(history, snap.fetchedAt);
    await this.mem.update(K_HISTORY, history);
    await this.mem.update(K_LAST, snap);
  }

  get cycles(): CycleSummary[] {
    return this.mem.get<CycleSummary[]>(K_CYCLES, []);
  }

  surplusNotified(resetDate: string): boolean {
    return this.mem.get<string>(K_SURPLUS) === cycleKey(resetDate);
  }

  async markSurplusNotified(resetDate: string): Promise<void> {
    await this.mem.update(K_SURPLUS, cycleKey(resetDate));
  }

  notifiedThresholds(resetDate: string): number[] {
    const s = this.mem.get<NotifiedState>(K_NOTIFIED);
    return s && s.cycle === cycleKey(resetDate) ? s.thresholds : [];
  }

  async markNotified(resetDate: string, threshold: number, all: number[]): Promise<void> {
    // Mark the crossed threshold and every lower one, so we never spam.
    const prev = this.notifiedThresholds(resetDate);
    const merged = [...new Set([...prev, ...all.filter((t) => t <= threshold)])];
    await this.mem.update(K_NOTIFIED, { cycle: cycleKey(resetDate), thresholds: merged });
  }

  get snoozedUntil(): number | undefined {
    const t = this.mem.get<number>(K_SNOOZE, 0);
    return t > Date.now() ? t : undefined;
  }

  async unsnooze(): Promise<void> {
    await this.mem.update(K_SNOOZE, 0);
  }

  get snoozed(): boolean {
    return Date.now() < this.mem.get<number>(K_SNOOZE, 0);
  }

  async snooze(hours: number): Promise<void> {
    await this.mem.update(K_SNOOZE, Date.now() + hours * 3_600_000);
  }

  paceWarnedToday(): boolean {
    return this.mem.get<string>(K_PACE_DAY) === new Date().toISOString().slice(0, 10);
  }

  async markPaceWarned(): Promise<void> {
    await this.mem.update(K_PACE_DAY, new Date().toISOString().slice(0, 10));
  }
}
