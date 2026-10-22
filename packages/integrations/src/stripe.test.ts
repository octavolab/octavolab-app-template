import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { StripeGateway, mapStripeError } from "./stripe.js";
import { PaymentError } from "./contracts.js";

const secret = "whsec_testsecret";
function sign(body: string, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}
const gw = (extra: Partial<ConstructorParameters<typeof StripeGateway>[0]> = {}) => new StripeGateway({ mode: "sandbox", ...extra });

/** fetch double: answers each call with the next queued response (or throws the queued error). */
function queue(...answers: ({ status: number; body?: unknown; headers?: Record<string, string> } | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const a = answers.shift() ?? { status: 200, body: { id: "pi_default" } };
    if (a instanceof Error) throw a;
    return new Response(a.body === undefined ? "not json" : JSON.stringify(a.body), { status: a.status, headers: a.headers ?? {} });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}
const noSleep = async () => {};

describe("StripeGateway.verifyWebhook", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = secret;
  });
  it("accepts a correctly signed event", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: {}, livemode: false });
    const ev = await gw().verifyWebhook(body, sign(body));
    expect(ev.eventId).toBe("evt_1");
  });
  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "x", data: {} });
    await expect(gw().verifyWebhook(body + " ", sign(body))).rejects.toThrow("invalid signature");
  });
  it("rejects an old timestamp (replay)", async () => {
    const body = "{}";
    await expect(gw().verifyWebhook(body, sign(body, 1_000))).rejects.toThrow("tolerance");
  });
  it("rejects a non-numeric or empty timestamp even when the MAC is computed over it", async () => {
    const body = "{}";
    for (const t of ["", "abc", "1e9", "-1", "0x10", "1.5"]) {
      const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
      await expect(gw().verifyWebhook(body, `t=${t},v1=${v1}`)).rejects.toThrow(/invalid signature (timestamp|header)/);
    }
  });
  it("accepts any of several v1 signatures (secret roll) and rejects a missing v1", async () => {
    const body = JSON.stringify({ id: "evt_2", type: "x", data: {} });
    const good = sign(body);
    const t = good.split(",")[0];
    const ev = await gw().verifyWebhook(body, `${t},v1=${"0".repeat(64)},${good.split(",")[1]}`);
    expect(ev.eventId).toBe("evt_2");
    await expect(gw().verifyWebhook(body, t!)).rejects.toThrow("invalid signature header");
  });
  it("refuses an event whose livemode does not match the payments mode", async () => {
    const live = JSON.stringify({ id: "evt_3", type: "payment_intent.succeeded", data: {}, livemode: true });
    await expect(gw().verifyWebhook(live, sign(live))).rejects.toThrow("livemode");
    process.env.STRIPE_SECRET_KEY = "sk_live_xxx";
    const test = JSON.stringify({ id: "evt_4", type: "payment_intent.succeeded", data: {}, livemode: false });
    await expect(new StripeGateway({ mode: "live" }).verifyWebhook(test, sign(test))).rejects.toThrow("livemode");
  });
  it("fails without a webhook secret", async () => {
    await expect(gw({ webhookSecret: "" }).verifyWebhook("{}", sign("{}"))).rejects.toThrow("STRIPE_WEBHOOK_SECRET missing");
  });
});

describe("StripeGateway API calls", () => {
  beforeEach(() => { process.env.STRIPE_SECRET_KEY = "sk_test_xxx"; });

  it("creates and retrieves payment intents with integer minor units, lower-case ISO currency and an idempotency key", async () => {
    const f = queue({ status: 200, body: { id: "pi_123", client_secret: "pi_123_secret_x", status: "requires_payment_method" } }, { status: 200, body: { id: "pi_123", client_secret: "pi_123_secret_x", status: "requires_payment_method" } });
    const g = gw({ fetchImpl: f.impl });
    const created = await g.createPaymentIntent({ orderId: "o1", money: { amount: 2500, currency: "USD" }, idempotencyKey: "checkout:o1" });
    expect(created).toEqual({ providerRef: "pi_123", clientSecret: "pi_123_secret_x" });
    const body = new URLSearchParams(String(f.calls[0]!.init.body));
    expect([body.get("amount"), body.get("currency"), body.get("metadata[orderId]")]).toEqual(["2500", "usd", "o1"]);
    const h = f.calls[0]!.init.headers as Record<string, string>;
    expect([h["Idempotency-Key"], h.Authorization, h["Content-Type"]]).toEqual(["checkout:o1", "Bearer sk_test_xxx", "application/x-www-form-urlencoded"]);
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect((await g.retrievePaymentIntent("pi_123")).status).toBe("requires_payment_method");
    expect(f.calls[1]!.url).toBe("https://api.stripe.com/v1/payment_intents/pi_123");
    expect(f.calls[1]!.init.method).toBe("GET");
    await expect(g.retrievePaymentIntent("../charges")).rejects.toThrow("invalid payment intent id");
  });

  it("uses the global fetch by default", async () => {
    const real = globalThis.fetch;
    const f = queue({ status: 200, body: { id: "pi_g" } });
    globalThis.fetch = f.impl;
    try { expect((await gw().retrievePaymentIntent("pi_g")).status).toBe("unknown"); } finally { globalThis.fetch = real; }
  });

  it("refunds with the same idempotency key on every retry and validates money before calling", async () => {
    const f = queue({ status: 500, body: { error: { type: "api_error" } } }, { status: 200, body: { id: "re_1" } });
    const g = gw({ fetchImpl: f.impl, sleep: noSleep });
    expect(await g.refund({ providerRef: "pi_1", money: { amount: 100, currency: "EUR" }, idempotencyKey: "refund:o1" })).toEqual({ providerRef: "re_1" });
    expect(f.calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"])).toEqual(["refund:o1", "refund:o1"]);
    expect(new URLSearchParams(String(f.calls[0]!.init.body)).get("amount")).toBe("100");
    for (const money of [{ amount: 1.5, currency: "EUR" }, { amount: 0, currency: "EUR" }, { amount: 10, currency: "eur" }]) {
      await expect(g.refund({ providerRef: "pi_1", money, idempotencyKey: "k" })).rejects.toBeInstanceOf(PaymentError);
    }
    await expect(g.refund({ providerRef: "ch_1", money: { amount: 1, currency: "EUR" }, idempotencyKey: "k" })).rejects.toMatchObject({ code: "invalid_reference" });
    await expect(g.createPaymentIntent({ orderId: "o", money: { amount: -1, currency: "USD" }, idempotencyKey: "k" })).rejects.toMatchObject({ code: "invalid_amount" });
    expect(f.calls.length).toBe(2);
  });

  it("never sends a POST without an idempotency key", async () => {
    const f = queue();
    await expect(gw({ fetchImpl: f.impl }).createPaymentIntent({ orderId: "o", money: { amount: 1, currency: "USD" }, idempotencyKey: "" })).rejects.toMatchObject({ code: "idempotency_key_required" });
    expect(f.calls.length).toBe(0);
  });

  it("retries network errors, timeouts, 429 and 5xx up to 3 attempts, honouring Stripe-Should-Retry", async () => {
    const ok = { status: 200, body: { id: "pi_r" } };
    const f1 = queue(new TypeError("fetch failed"), { status: 429, body: {} }, ok);
    expect((await gw({ fetchImpl: f1.impl, sleep: noSleep }).retrievePaymentIntent("pi_r")).providerRef).toBe("pi_r");
    expect(f1.calls.length).toBe(3);
    const f2 = queue({ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }, ok);
    await expect(gw({ fetchImpl: f2.impl, sleep: noSleep }).retrievePaymentIntent("pi_r")).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(f2.calls.length).toBe(3);
    const f3 = queue({ status: 500, body: {}, headers: { "stripe-should-retry": "false" } }, ok);
    await expect(gw({ fetchImpl: f3.impl, sleep: noSleep }).retrievePaymentIntent("pi_r")).rejects.toMatchObject({ retryable: false });
    expect(f3.calls.length).toBe(1);
    const f4 = queue({ status: 400, body: { error: { code: "parameter_invalid_integer" } } }, ok);
    await expect(gw({ fetchImpl: f4.impl, sleep: noSleep }).retrievePaymentIntent("pi_r")).rejects.toMatchObject({ code: "rejected", message: "stripe payment_intents 400 parameter_invalid_integer" });
    expect(f4.calls.length).toBe(1);
  });

  it("times out a slow provider", async () => {
    const slow = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
    })) as unknown as typeof fetch;
    const err = await gw({ fetchImpl: slow, timeoutMs: 10, attempts: 1 }).retrievePaymentIntent("pi_x").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "timeout", retryable: true, message: "stripe payment_intents timeout after 10 ms" });
  });

  it("treats a 2xx without an id as a bad response and never leaks the key in errors", async () => {
    const err = (await gw({ fetchImpl: queue({ status: 200 }, { status: 200 }, { status: 200 }).impl, sleep: noSleep }).retrievePaymentIntent("pi_x").catch((e: unknown) => e)) as PaymentError;
    expect(err.code).toBe("bad_response");
    const leaky = (await gw({ fetchImpl: queue({ status: 401, body: { error: { code: "Invalid sk_test_xxx", message: "sk_test_xxx" } } }).impl }).retrievePaymentIntent("pi_x").catch((e: unknown) => e)) as PaymentError;
    expect(leaky.message).toBe("stripe payment_intents 401 error");
    expect(String(leaky.stack)).not.toContain("sk_test_xxx");
  });

  it("ping reads the balance and maps failures", async () => {
    const f = queue({ status: 200, body: { object: "balance" } });
    await gw({ fetchImpl: f.impl }).ping();
    expect([f.calls[0]!.url, f.calls[0]!.init.method]).toEqual(["https://api.stripe.com/v1/balance", "GET"]);
    await expect(gw({ fetchImpl: queue({ status: 401, body: {} }).impl }).ping()).rejects.toMatchObject({ code: "auth" });
    await expect(gw({ fetchImpl: queue(new TypeError("down")).impl }).ping()).rejects.toMatchObject({ code: "network" });
  });

  it("refuses a key that does not match the mode, and a missing key", () => {
    expect(() => new StripeGateway({ mode: "live" })).toThrow("live mode requires a live key");
    expect(() => new StripeGateway({ mode: "sandbox", secretKey: "sk_live_xxx" })).toThrow("sandbox mode requires a test key");
    expect(new StripeGateway({ mode: "sandbox", secretKey: "rk_test_xxx" }).name).toBe("stripe");
    delete process.env.STRIPE_SECRET_KEY;
    expect(() => new StripeGateway({ mode: "sandbox" })).toThrow("STRIPE_SECRET_KEY missing");
  });
});

describe("mapStripeError", () => {
  it("classifies statuses", () => {
    const c = (status: number, code = "", retry: string | null = null) => { const e = mapStripeError("refunds", status, code, retry); return [e.code, e.retryable]; };
    expect(c(429)).toEqual(["rate_limited", true]);
    expect(c(502)).toEqual(["provider_unavailable", true]);
    expect(c(403)).toEqual(["auth", false]);
    expect(c(409, "idempotency_key_in_use")).toEqual(["idempotency", false]);
    expect(c(409, "lock_timeout")).toEqual(["idempotency", true]);
    expect(c(402, "card_declined")).toEqual(["declined", false]);
    expect(c(404)).toEqual(["rejected", false]);
    expect(c(400, "", "true")).toEqual(["rejected", true]);
    expect(mapStripeError("../x", 400, "<b>", null).message).toBe("stripe request 400 error");
  });
});
