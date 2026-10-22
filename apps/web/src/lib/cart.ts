import type { Product } from "./api";

/** Cart lines live in React state only (no localStorage for business data). Prices are display hints: the server reprices every order. */
export type CartLine = { sku: string; qty: number };
export const MAX_QTY = 1000; // POST /me/orders accepts qty 1..1000 per line
export const MAX_LINES = 50; // and at most 50 lines

export function setQty(lines: CartLine[], sku: string, qty: number): CartLine[] {
  const q = Math.max(0, Math.min(MAX_QTY, Math.trunc(qty)));
  const exists = lines.some((l) => l.sku === sku);
  if (q === 0) return lines.filter((l) => l.sku !== sku);
  if (exists) return lines.map((l) => (l.sku === sku ? { ...l, qty: q } : l));
  if (lines.length >= MAX_LINES) return lines;
  return [...lines, { sku, qty: q }];
}

export function addOne(lines: CartLine[], sku: string): CartLine[] {
  return setQty(lines, sku, (lines.find((l) => l.sku === sku)?.qty ?? 0) + 1);
}

export type CartSummary = { count: number; totals: { currency: string; amount: number }[]; mixedCurrency: boolean; unavailable: string[] };

/** Totals per currency (minor units); lines whose product left the catalog are reported as unavailable. */
export function summarize(lines: CartLine[], products: Product[]): CartSummary {
  const bySku = new Map(products.map((p) => [p.sku, p] as const));
  const totals = new Map<string, number>();
  const unavailable: string[] = [];
  let count = 0;
  for (const l of lines) {
    const p = bySku.get(l.sku);
    if (!p || !p.active) { unavailable.push(l.sku); continue; }
    count += l.qty;
    totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.unitAmount * l.qty);
  }
  return { count, totals: [...totals].map(([currency, amount]) => ({ currency, amount })), mixedCurrency: totals.size > 1, unavailable };
}
