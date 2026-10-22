import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentGateway, Money } from "./contracts.js";
import { PaymentError } from "./contracts.js";
import { retryWithJitter, type Sleep } from "./resilience.js";
import { stripeKeyMatchesMode } from "./config.js";

/**
 * Stripe adapter (hosted fields / Payment Element: the server never sees card numbers; PCI SAQ A).
 * HTTP API through fetch, no SDK. API reference: https://docs.stripe.com/api (read 2026-10-22, N02); operations notes,
 * webhook URL and the events to subscribe: docs/integrations/stripe.md.
 *
 * - `sandbox` requires a test key (`sk_test_` / `rk_test_`), `live` a live key; a mismatch refuses to construct (the API
 *   env schema rejects it at boot first). `live` additionally needs ALLOW_LIVE=true (config.ts).
 * - Every mutating call (POST) carries an Idempotency-Key; a POST without one is a programming error and never leaves
 *   the process. Retries reuse the same key, so a retried create can never produce a second intent or refund.
 * - Amounts are integers in minor units; the currency is explicit (ISO 4217, sent lower-case as Stripe expects).
 * - Each attempt has a timeout (default 10 s); up to 3 attempts with full-jitter backoff on network errors, timeouts,
 *   429 and 5xx, and never when Stripe answers `Stripe-Should-Retry: false`.
 * - Errors are PaymentError with a sanitized message (`stripe <resource> <status> <code>`): never the key or free text.
 * - Webhooks: HMAC-SHA256 over `<t>.<raw body>` with STRIPE_WEBHOOK_SECRET, constant-time compare, 5-minute tolerance,
 *   and the event's `livemode` must match the adapter's mode. Replays are made harmless by the caller, which stores the
 *   event id under a unique constraint (WebhookEvent) in the same transaction as the effects.
 */
const API = "https://api.stripe.com/v1/";
const RESOURCE = /^[a-z_]+$/;

export type StripeOptions = {
  mode: "sandbox" | "live";
  secretKey?: string | undefined;
  webhookSecret?: string | undefined;
  timeoutMs?: number | undefined;
  attempts?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  sleep?: Sleep | undefined;
};

type StripeObject = { id: string; client_secret?: string; status?: string };

export class StripeGateway implements PaymentGateway {
  readonly name = "stripe";
  private readonly mode: "sandbox" | "live";
  private readonly key: string;
  private readonly webhookSecret: string | undefined;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep | undefined;

  constructor(opts: StripeOptions) {
    const key = opts.secretKey ?? process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY missing");
    if (!stripeKeyMatchesMode(key, opts.mode)) throw new Error(opts.mode === "live" ? "live mode requires a live key" : "sandbox mode requires a test key"); // never echo the value
    this.mode = opts.mode;
    this.key = key;
    this.webhookSecret = opts.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.attempts = opts.attempts ?? 3;
    // Resolved at call time by default so tests (and runtime instrumentation) can replace globalThis.fetch.
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
    this.sleep = opts.sleep;
  }

  private async call(method: "GET" | "POST", path: string, body?: URLSearchParams, idempotencyKey?: string): Promise<StripeObject> {
    const resource = path.split("/")[0]!;
    if (method === "POST" && !idempotencyKey) throw new PaymentError(`stripe ${resource} idempotency key required`, "idempotency_key_required", false);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}`, "User-Agent": "octavolab-app-template" };
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey.slice(0, 255);

    return retryWithJitter(async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(`${API}${path}`, { method, headers, ...(body ? { body: body.toString() } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new PaymentError(timedOut ? `stripe ${resource} timeout after ${this.timeoutMs} ms` : `stripe ${resource} network error`, timedOut ? "timeout" : "network", true);
      }
      const payload = (await res.json().catch(() => ({}))) as Partial<StripeObject> & { error?: { code?: unknown; type?: unknown } };
      if (res.ok) {
        if (typeof payload.id !== "string" || !payload.id) throw new PaymentError(`stripe ${resource} response without id`, "bad_response", true, res.status);
        return payload as StripeObject;
      }
      const code = typeof payload.error?.code === "string" ? payload.error.code : typeof payload.error?.type === "string" ? payload.error.type : "";
      throw mapStripeError(resource, res.status, code, res.headers.get("stripe-should-retry"));
    }, { attempts: this.attempts, baseMs: 250, maxMs: 2_000, isRetryable: (e) => e instanceof PaymentError && e.retryable, sleep: this.sleep });
  }

  async createPaymentIntent(i: { orderId: string; money: Money; idempotencyKey: string }) {
    assertMoney(i.money);
    const r = await this.call("POST", "payment_intents", new URLSearchParams({
      amount: String(i.money.amount),
      currency: i.money.currency.toLowerCase(),
      "metadata[orderId]": i.orderId,
    }), i.idempotencyKey);
    return { providerRef: r.id, clientSecret: r.client_secret };
  }

  async retrievePaymentIntent(providerRef: string) {
    if (!/^pi_[A-Za-z0-9_]+$/.test(providerRef)) throw new PaymentError("invalid payment intent id", "invalid_reference", false);
    const r = await this.call("GET", `payment_intents/${providerRef}`);
    return { providerRef: r.id, clientSecret: r.client_secret, status: r.status ?? "unknown" };
  }

  async verifyWebhook(rawBody: string, signature: string) {
    const secret = this.webhookSecret; if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET missing");
    // Header: t=<unix seconds>,v1=<hex>[,v1=<hex> during secret rolls][,v0=...]
    const pairs = signature.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const; });
    const t = pairs.find(([k]) => k === "t")?.[1];
    const v1s = pairs.filter(([k]) => k === "v1").map(([, v]) => v);
    if (!t || v1s.length === 0) throw new Error("invalid signature header");
    if (!/^\d{1,12}$/.test(t)) throw new Error("invalid signature timestamp"); // Number("") is 0 and Number("1e3") is 1000: accept digits only
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new Error("signature timestamp outside tolerance");
    const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
    const ok = v1s.some((v1) => v1.length === expected.length && timingSafeEqual(expected, Buffer.from(v1)));
    if (!ok) throw new Error("invalid signature");
    const d = JSON.parse(rawBody) as { id: string; type: string; data: unknown; livemode?: unknown };
    // A test-mode endpoint must never act on a live event and vice versa (defence in depth: the secrets differ too).
    if (typeof d.livemode === "boolean" && d.livemode !== (this.mode === "live")) throw new Error("event livemode does not match the payments mode");
    return { eventId: d.id, type: d.type, data: d.data };
  }

  async refund(i: { providerRef: string; money: Money; idempotencyKey: string }) {
    assertMoney(i.money);
    if (!/^pi_[A-Za-z0-9_]+$/.test(i.providerRef)) throw new PaymentError("invalid payment intent id", "invalid_reference", false);
    // A refund has no currency parameter: it is always in the intent's currency. The amount is in that currency's minor units.
    const r = await this.call("POST", "refunds", new URLSearchParams({ payment_intent: i.providerRef, amount: String(i.money.amount) }), i.idempotencyKey);
    return { providerRef: r.id };
  }

  /** `GET /v1/balance`: cheapest authenticated read (a restricted key needs "Balance: read"). */
  async ping(): Promise<void> {
    const res = await this.fetchImpl(`${API}balance`, { method: "GET", headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(Math.min(this.timeoutMs, 3_000)) })
      .catch(() => { throw new PaymentError("stripe balance network error", "network", true); });
    if (!res.ok) throw mapStripeError("balance", res.status, "", null);
  }
}

function assertMoney(m: Money) {
  if (!Number.isSafeInteger(m.amount) || m.amount <= 0) throw new PaymentError("amount must be a positive integer in minor units", "invalid_amount", false);
  if (!/^[A-Z]{3}$/.test(m.currency)) throw new PaymentError("currency must be an ISO 4217 code", "invalid_currency", false);
}

/** Provider status + error code -> sanitized, classified PaymentError. Only a whitelisted code shape reaches the message. */
export function mapStripeError(resource: string, status: number, providerCode: string, shouldRetry: string | null): PaymentError {
  const code = /^[a-z_]{1,64}$/.test(providerCode) ? providerCode : "error";
  const msg = `stripe ${RESOURCE.test(resource) ? resource : "request"} ${status} ${code}`;
  const retryHint = shouldRetry === "true" ? true : shouldRetry === "false" ? false : undefined;
  if (status === 429) return new PaymentError(msg, "rate_limited", retryHint ?? true, status);
  if (status >= 500) return new PaymentError(msg, "provider_unavailable", retryHint ?? true, status);
  if (status === 401 || status === 403) return new PaymentError(msg, "auth", false, status);
  if (status === 409) return new PaymentError(msg, "idempotency", retryHint ?? code === "lock_timeout", status);
  if (status === 402) return new PaymentError(msg, "declined", false, status);
  return new PaymentError(msg, "rejected", retryHint ?? false, status); // 400, 404: the request itself is wrong
}
