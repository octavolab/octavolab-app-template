/** Explicit order state machine (Módulo C 4.8): invalid transitions are rejected by the service, never only by the UI. */
export type OrderStatus = "draft" | "confirmed" | "paid" | "shipped" | "delivered" | "closed" | "cancelled" | "refunded";

const NEXT: Record<OrderStatus, OrderStatus[]> = {
  draft: ["confirmed", "cancelled"],
  confirmed: ["paid", "cancelled"],
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
