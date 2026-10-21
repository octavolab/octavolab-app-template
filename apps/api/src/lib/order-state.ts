/** Explicit order state machine (Módulo C 4.8): invalid transitions are rejected by the service, never only by the UI. */
export type OrderStatus = "draft" | "confirmed" | "pending_payment" | "paid" | "shipped" | "delivered" | "closed" | "cancelled" | "refunded";

/**
 * Checkout: draft (or confirmed) -> pending_payment when a payment intent is created; the signed provider webhook then
 * moves pending_payment -> paid. confirmed -> paid stays for payments collected outside the checkout endpoint.
 */
const NEXT: Record<OrderStatus, OrderStatus[]> = {
  draft: ["confirmed", "pending_payment", "cancelled"],
  confirmed: ["pending_payment", "paid", "cancelled"],
  pending_payment: ["paid", "cancelled"],
  paid: ["shipped", "refunded"],
  shipped: ["delivered"],
  delivered: ["closed", "refunded"],
  closed: [],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return NEXT[from].includes(to);
}

/** States from which `to` is reachable in one step (used for optimistic, race-safe updates). */
export function sourcesOf(to: OrderStatus): OrderStatus[] {
  return (Object.keys(NEXT) as OrderStatus[]).filter((from) => NEXT[from].includes(to));
}
