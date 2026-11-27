/**
 * Prioritised context budget for btw: the context pieces (chat turns, diff hunks
 * per file, touched files, editor) compete for a fixed character budget.
 * Order of preference: pieces relevant to the question > recent chat turns >
 * diff > touched files > editor. Kept pieces are returned in their original
 * order so the prompt stays readable. No vscode import (unit-testable).
 */

export type PieceKind = 'chat' | 'diff' | 'file' | 'editor';

export interface ContextPiece {
  kind: PieceKind;
  /** Short label, e.g. "turn 6", "src/app.ts". */
  label: string;
  text: string;
  /** Within a kind, higher goes first (e.g. newer chat turns). Default 0. */
  rank?: number;
  /** Always relevant (e.g. the editor selection the question is about). */
  pinned?: boolean;
}

export interface BudgetedPiece extends ContextPiece {
  /** True if the text was shortened to fit. */
  clipped: boolean;
  /** Question relevance score used for ordering (0 = none). */
  relevance: number;
}

const KIND_ORDER: Record<PieceKind, number> = { chat: 3, diff: 2, file: 1, editor: 0 };
/** Below this many remaining characters a shortened piece is not worth adding. */
const MIN_CLIP = 300;

const STOP = new Set(
  (
    'the and for are but not you your with this that what why how when where which who does did done was were has have had ' +
    'can could should would will from into about there here then than them they its it\'s also just only some any all ' +
    'der die das und oder aber nicht ist sind war wie was warum wann wo wer welche welcher mit von für auf aus ein eine ' +
    'einen einem einer den dem des zu im in am an ob dass noch nur auch schon mal hier dort bitte gerade jetzt'
  ).split(/\s+/),
);

/** Distinctive words of the question: identifiers, file names, words of 3+ letters minus stop words. */
export function questionTerms(question: string): string[] {
  const out = new Set<string>();
  for (const m of question.matchAll(/[\p{L}\p{N}_$][\p{L}\p{N}_$.\-/]*/gu)) {
    const raw = m[0].replace(/[.\-/]+$/, '');
    const t = raw.toLowerCase();
    if (t.length < 3 || STOP.has(t) || /^\d+$/.test(t)) {
      continue;
    }
    out.add(t);
    // "src/app.ts" → also "app.ts" and "app"; "fooBar.baz" → "foobar".
    const base = t.split('/').pop()!;
    if (base !== t && base.length >= 3) {
      out.add(base);
    }
    const stem = base.replace(/\.[a-z0-9]+$/, '');
    if (stem !== base && stem.length >= 3) {
      out.add(stem);
    }
  }
  return [...out];
}

/** How many of the terms occur in the text (case-insensitive); file-name hits count double. */
export function relevance(terms: readonly string[], text: string, label = ''): number {
  if (!terms.length) {
    return 0;
  }
  const hay = text.toLowerCase();
  const lab = label.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (lab && lab.includes(t)) {
      score += 2;
    } else if (hay.includes(t)) {
      score += 1;
    }
  }
  return score;
}

/** Shortens text to `max` chars, keeping head and tail. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 40) {
    return text.slice(0, Math.max(0, max));
  }
  const marker = '\n… [shortened] …\n';
  const keep = max - marker.length;
  const head = Math.ceil(keep * 0.65);
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

/**
 * Picks pieces within `budget` characters. Relevant pieces (pinned or matching
 * question terms) come first, by score; the rest follow by kind and rank. A piece
 * that does not fit is shortened if at least MIN_CLIP characters are left.
 */
export function budgetPieces(pieces: readonly ContextPiece[], question: string, budget: number): BudgetedPiece[] {
  const terms = questionTerms(question);
  const scored = pieces.map((p, index) => ({
    p,
    index,
    rel: p.pinned ? 1000 : relevance(terms, p.text, p.label),
  }));
  const order = [...scored].sort(
    (a, b) =>
      Number(b.rel > 0) - Number(a.rel > 0) ||
      b.rel - a.rel ||
      KIND_ORDER[b.p.kind] - KIND_ORDER[a.p.kind] ||
      (b.p.rank ?? 0) - (a.p.rank ?? 0) ||
      a.index - b.index,
  );
  let left = Math.max(0, budget);
  const kept = new Map<number, BudgetedPiece>();
  for (const { p, index, rel } of order) {
    if (!p.text) {
      continue;
    }
    if (p.text.length <= left) {
      kept.set(index, { ...p, clipped: false, relevance: rel });
      left -= p.text.length;
    } else if (left >= MIN_CLIP) {
      const text = clip(p.text, left);
      kept.set(index, { ...p, text, clipped: true, relevance: rel });
      left -= text.length;
    }
  }
  return [...kept.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}
