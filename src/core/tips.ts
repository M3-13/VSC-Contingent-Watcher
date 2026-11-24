import { PaceStatus } from './types';
import { TIPS } from './tipsData';

export { TIPS };

/**
 * Situations a tip can be relevant for: the pace status plus phase of the
 * month and "allowance would expire unused". 'general' = always useful.
 */
export type Situation = PaceStatus | 'surplus' | 'earlyMonth' | 'lateMonth' | 'general';

export interface Tip {
  id: string;
  when: Situation[];
  /** English source string; translated via vscode.l10n at render time. */
  text: string;
}

export interface SituationInput {
  status: PaceStatus;
  /** 0..1 share of the cycle elapsed. */
  cycleElapsed: number;
  surplus: boolean;
}

/** Derives the active situations (most specific first). */
export function situationsFor(i: SituationInput): Situation[] {
  const out: Situation[] = [];
  if (i.surplus) {
    out.push('surplus');
  }
  out.push(i.status);
  if (i.cycleElapsed < 0.25) {
    out.push('earlyMonth');
  } else if (i.cycleElapsed > 0.75) {
    out.push('lateMonth');
  }
  return out;
}

function rotate<T>(list: T[], seed: number): T[] {
  if (list.length === 0) {
    return list;
  }
  const k = Math.abs(Math.floor(seed)) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

/**
 * The tips relevant right now: specific ones for the active situations first
 * (rotating daily via seed), filled up with general tips. Between `min` and `max`.
 */
export function relevantTips(situations: Situation[], seed: number, max = 5, min = 3, tips: Tip[] = TIPS): Tip[] {
  const picked: Tip[] = [];
  const add = (t: Tip) => {
    if (picked.length < max && !picked.some((p) => p.id === t.id)) {
      picked.push(t);
    }
  };
  // Most specific situation first, at most 2 tips per situation so several show up.
  const perSituation = situations.map((s) => rotate(tips.filter((t) => t.when.includes(s)), seed));
  for (let round = 0; round < 2; round++) {
    for (const list of perSituation) {
      const next = list.filter((t) => !picked.some((p) => p.id === t.id))[0];
      if (next) {
        add(next);
      }
    }
  }
  for (const t of rotate(tips.filter((t) => t.when.includes('general')), seed)) {
    if (picked.length >= min) {
      break;
    }
    add(t);
  }
  return picked;
}

/** One tip for compact places (status bar tooltip). */
export function pickTip(situations: Situation[] | PaceStatus, seed: number): Tip {
  const list = typeof situations === 'string' ? [situations] : situations;
  return relevantTips(list, seed, 1, 1)[0] ?? TIPS[0];
}
