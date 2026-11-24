/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ModelUsage {
  model: string;
  quantity: number;
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
  const totals = new Map<string, number>();
  for (const it of raw) {
    const model = typeof it?.model === 'string' && it.model ? it.model : typeof it?.sku === 'string' ? it.sku : undefined;
    const q = num(it?.grossQuantity) ?? num(it?.gross_quantity) ?? num(it?.quantity) ?? num(it?.netQuantity) ?? 0;
    if (!model || q <= 0) {
      continue;
    }
    totals.set(model, (totals.get(model) ?? 0) + q);
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals.entries()]
    .map(([model, quantity]) => ({ model, quantity, share: sum > 0 ? quantity / sum : 0 }))
    .sort((a, b) => b.quantity - a.quantity);
}
