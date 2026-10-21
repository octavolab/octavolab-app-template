/** Money is always an integer in the minor unit (cents) with an ISO currency code. */
export type Money = { amount: number; currency: "USD" | "GBP" | "EUR" | "COP" | "MXN" | "BRL" };
export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error("currency mismatch");
  return { amount: a.amount + b.amount, currency: a.currency };
}
export function assertMoney(m: Money): void {
  if (!Number.isInteger(m.amount) || m.amount < 0) throw new Error("amount must be a non-negative integer in minor units");
}
