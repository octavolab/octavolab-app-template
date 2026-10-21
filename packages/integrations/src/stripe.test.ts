import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { StripeGateway } from "./stripe.js";

const secret = "whsec_test_secret";
function sign(body: string, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("StripeGateway.verifyWebhook", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = secret;
  });
  it("accepts a correctly signed event", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: {} });
    const ev = await new StripeGateway(false).verifyWebhook(body, sign(body));
    expect(ev.eventId).toBe("evt_1");
  });
  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "x", data: {} });
    await expect(new StripeGateway(false).verifyWebhook(body + " ", sign(body))).rejects.toThrow("invalid signature");
  });
  it("rejects an old timestamp (replay)", async () => {
    const body = "{}";
    await expect(new StripeGateway(false).verifyWebhook(body, sign(body, 1_000))).rejects.toThrow("tolerance");
  });
  it("rejects a non-numeric or empty timestamp even when the MAC is computed over it", async () => {
    const body = "{}";
    for (const t of ["", "abc", "1e9", "-1", "0x10", "1.5"]) {
      const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
      await expect(new StripeGateway(false).verifyWebhook(body, `t=${t},v1=${v1}`)).rejects.toThrow(/invalid signature (timestamp|header)/);
    }
  });
  it("accepts any of several v1 signatures (secret roll) and rejects a missing v1", async () => {
    const body = JSON.stringify({ id: "evt_2", type: "x", data: {} });
    const good = sign(body);
    const t = good.split(",")[0];
    const ev = await new StripeGateway(false).verifyWebhook(body, `${t},v1=${"0".repeat(64)},${good.split(",")[1]}`);
    expect(ev.eventId).toBe("evt_2");
    await expect(new StripeGateway(false).verifyWebhook(body, t!)).rejects.toThrow("invalid signature header");
  });
  it("creates and retrieves payment intents with integer minor units, lower-case ISO currency and an idempotency key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: "pi_123", client_secret: "pi_123_secret_x", status: "requires_payment_method" }), { status: 200 }); }) as typeof fetch;
    try {
      const gw = new StripeGateway(false);
      const created = await gw.createPaymentIntent({ orderId: "o1", money: { amount: 2500, currency: "USD" }, idempotencyKey: "checkout:o1" });
      expect(created).toEqual({ providerRef: "pi_123", clientSecret: "pi_123_secret_x" });
      const body = new URLSearchParams(String(calls[0]!.init.body));
      expect([body.get("amount"), body.get("currency"), body.get("metadata[orderId]")]).toEqual(["2500", "usd", "o1"]);
      expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("checkout:o1");
      expect((await gw.retrievePaymentIntent("pi_123")).status).toBe("requires_payment_method");
      expect(calls[1]!.url).toBe("https://api.stripe.com/v1/payment_intents/pi_123");
      expect(calls[1]!.init.method).toBe("GET");
      await expect(gw.retrievePaymentIntent("../charges")).rejects.toThrow("invalid payment intent id");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("refuses live mode with a test key", () => {
    expect(() => new StripeGateway(true)).toThrow("live mode requires a live key");
  });
});
