/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ModelUsage {
  model: string;
  /** Requests (or other billed units) used. */
  quantity: number;
  /** Credits used (1 credit = $0.01 of gross amount), if the report has amounts. */
  credits?: number;
  share: number;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Parses the billing usage report (premium request usage endpoint) into
 * per-model totals. Tolerant: accepts `usageItems` or `usage_items`, and
 * gross/net/plain quantity fields.
 */
export function parseModelUsage(body: any): ModelUsage[] {
  const raw: any[] = Array.isArray(body?.usageItems) ? body.usageItems : Array.isArray(body?.usage_items) ? body.usage_items : [];
  const totals = new Map<string, { quantity: number; amount: number; hasAmount: boolean }>();
  for (const it of raw) {
    const model = typeof it?.model === 'string' && it.model ? it.model : typeof it?.sku === 'string' ? it.sku : undefined;
    const q = num(it?.grossQuantity) ?? num(it?.gross_quantity) ?? num(it?.quantity) ?? num(it?.netQuantity) ?? 0;
    const amount = num(it?.grossAmount) ?? num(it?.gross_amount) ?? num(it?.amount);
    if (!model || (q <= 0 && !(amount && amount > 0))) {
      continue;
    }
    const t = totals.get(model) ?? { quantity: 0, amount: 0, hasAmount: false };
    t.quantity += Math.max(0, q);
    if (amount !== undefined) {
      t.amount += amount;
      t.hasAmount = true;
    }
    totals.set(model, t);
  }
  const withCredits = [...totals.values()].every((t) => t.hasAmount);
  // Share by credits when every row has an amount (that's what costs money).
  const weight = (t: { quantity: number; amount: number }) => (withCredits ? t.amount : t.quantity);
  const sum = [...totals.values()].reduce((a, t) => a + weight(t), 0);
  return [...totals.entries()]
    .map(([model, t]) => ({
      model,
      quantity: t.quantity,
      credits: withCredits ? Math.round(t.amount * 100 * 10) / 10 : undefined,
      share: sum > 0 ? weight(t) / sum : 0,
    }))
    .sort((a, b) => b.share - a.share);
}
