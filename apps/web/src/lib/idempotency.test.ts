import { describe, expect, it, vi } from "vitest";
import { IdempotencyKeeper, cartFingerprint, randomKey } from "./idempotency";
import { createCheckoutFlow } from "./checkout";
import { ApiError } from "./api";

const counter = () => { let n = 0; return () => `key-${++n}`; };

describe("IdempotencyKeeper", () => {
  it("reuses the key while the request is unchanged and rotates it when the request changes", () => {
    const k = new IdempotencyKeeper(counter());
    expect(k.keyFor("A:1")).toBe("key-1");
    expect(k.keyFor("A:1")).toBe("key-1"); // retry of the same cart
    expect(k.keyFor("A:2")).toBe("key-2"); // cart edited
    expect(k.keyFor("A:1")).toBe("key-3"); // edited back: a new operation, never an old key
  });
  it("issues a new key after reset (the previous operation succeeded)", () => {
    const k = new IdempotencyKeeper(counter());
    const first = k.keyFor("A:1");
    k.reset();
    expect(k.keyFor("A:1")).not.toBe(first);
  });
  it("fingerprints carts independently of line order", () => {
    expect(cartFingerprint([{ sku: "B", qty: 1 }, { sku: "A", qty: 2 }])).toBe(cartFingerprint([{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }]));
    expect(cartFingerprint([{ sku: "A", qty: 2 }])).not.toBe(cartFingerprint([{ sku: "A", qty: 3 }]));
  });
  it("generates UUID v4 keys within the API's 8..128 length bound", () => {
    const key = randomKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomKey()).not.toBe(key);
  });
});

describe("checkout flow retries", () => {
  type Call = { path: string; key: string | undefined; body: unknown };
  function fakeApi(fail: (c: Call, n: number) => Error | null) {
    const calls: Call[] = [];
    const call = vi.fn(async (path: string, opts: { body?: unknown; idempotencyKey?: string }) => {
      const c = { path, key: opts.idempotencyKey, body: opts.body };
      calls.push(c);
      const err = fail(c, calls.length);
      if (err) throw err;
      if (path === "/me/orders") return { id: "ord_1", items: [], totalAmount: 1500, currency: "GBP", status: "draft" };
      return { orderId: "ord_1", status: "pending_payment", paymentIntentId: "fake_pi_ord_1", amount: 1500, currency: "GBP" };
    });
    return { calls, call: call as unknown as Parameters<typeof createCheckoutFlow>[0] };
  }

  it("retrying the same cart after a network failure sends the same Idempotency-Keys", async () => {
    const { calls, call } = fakeApi((c, n) => (c.path.endsWith("/checkout") && n === 2 ? new ApiError(0, "NETWORK", "offline") : null));
    const flow = createCheckoutFlow(call);
    const cart = [{ sku: "DEMO-BOX-S", qty: 2 }];
    await expect(flow.placeOrder(cart)).rejects.toThrow("offline");
    await flow.placeOrder(cart);
    const orders = calls.filter((c) => c.path === "/me/orders");
    const pays = calls.filter((c) => c.path.endsWith("/checkout"));
    expect(orders).toHaveLength(2);
    expect(orders[0]!.key).toBeDefined();
    expect(orders[1]!.key).toBe(orders[0]!.key); // the server replays the same order
    expect(pays[1]!.key).toBe(pays[0]!.key); // and the same payment intent
    expect(orders[0]!.body).toEqual({ items: [{ sku: "DEMO-BOX-S", qty: 2 }] }); // SKUs and quantities only: prices come from the server
  });

  it("a changed cart gets a new key; a completed checkout resets the keys", async () => {
    const { calls, call } = fakeApi((c, n) => (n === 1 ? new ApiError(503, "INTERNAL", "down") : null));
    const flow = createCheckoutFlow(call);
    await expect(flow.placeOrder([{ sku: "A", qty: 1 }])).rejects.toThrow();
    await flow.placeOrder([{ sku: "A", qty: 2 }]); // edited after the failure
    await flow.placeOrder([{ sku: "A", qty: 2 }]); // a second, separate purchase of the same cart
    const keys = calls.filter((c) => c.path === "/me/orders").map((c) => c.key);
    expect(new Set(keys).size).toBe(3);
  });

  it("drops a key the server reports as used for another request", async () => {
    const { calls, call } = fakeApi((c, n) => (n === 1 ? new ApiError(422, "IDEMPOTENCY_MISMATCH", "mismatch") : null));
    const flow = createCheckoutFlow(call);
    await expect(flow.placeOrder([{ sku: "A", qty: 1 }])).rejects.toThrow();
    await flow.placeOrder([{ sku: "A", qty: 1 }]);
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
  });
});
