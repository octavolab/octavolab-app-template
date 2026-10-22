import { ApiError, type Checkout, type Order } from "./api";
import { IdempotencyKeeper, cartFingerprint } from "./idempotency";
import type { CartLine } from "./cart";

type ApiFn = <T>(path: string, opts: { method?: "POST"; body?: unknown; idempotencyKey?: string }) => Promise<T>;

/**
 * Customer checkout in two idempotent writes:
 *   1. POST /me/orders            (Idempotency-Key bound to the cart contents)
 *   2. POST /me/orders/:id/checkout (Idempotency-Key bound to the order id)
 * A retry of the same cart after any failure (network, 5xx, double click) reuses both keys, so the server replays the
 * same order and the same payment intent instead of creating duplicates. Editing the cart produces a new key.
 * Keys are reset only after the whole flow succeeded.
 */
export function createCheckoutFlow(call: ApiFn) {
  const orderKeys = new IdempotencyKeeper();
  const payKeys = new IdempotencyKeeper();

  async function payOrder(orderId: string): Promise<Checkout> {
    try {
      const res = await call<Checkout>(`/me/orders/${encodeURIComponent(orderId)}/checkout`, { method: "POST", idempotencyKey: payKeys.keyFor(orderId) });
      payKeys.reset();
      return res;
    } catch (e) {
      // The key was used for another request: a fresh key is the only way forward (the server resumes the same intent).
      if (e instanceof ApiError && e.code === "IDEMPOTENCY_MISMATCH") payKeys.reset();
      throw e;
    }
  }

  async function placeOrder(lines: CartLine[], onStep?: (step: "order" | "payment") => void): Promise<{ order: Order; checkout: Checkout }> {
    const items = lines.filter((l) => l.qty > 0).map((l) => ({ sku: l.sku, qty: l.qty }));
    onStep?.("order");
    let order: Order;
    try {
      order = await call<Order>("/me/orders", { method: "POST", body: { items }, idempotencyKey: orderKeys.keyFor(cartFingerprint(items)) });
    } catch (e) {
      if (e instanceof ApiError && e.code === "IDEMPOTENCY_MISMATCH") orderKeys.reset();
      throw e;
    }
    onStep?.("payment");
    const checkout = await payOrder(order.id);
    orderKeys.reset();
    return { order, checkout };
  }

  return { placeOrder, payOrder };
}
