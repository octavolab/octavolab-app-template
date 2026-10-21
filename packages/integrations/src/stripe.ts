import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentGateway, Money } from "./contracts.js";
import { withRetry } from "./contracts.js";
/**
 * Stripe adapter (hosted fields / Checkout: the server never sees card numbers; PCI SAQ A).
 * Read https://docs.stripe.com/api on the day of integration (N02) and record it in docs/integrations/stripe.md.
 * Requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET; `live` only with Jaime's approval (N07).
 */
export class StripeGateway implements PaymentGateway {
  name = "stripe";
  constructor(private readonly live: boolean) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY missing");
    if (live && !process.env.STRIPE_SECRET_KEY.startsWith("sk_live_")) throw new Error("live mode requires a live key");
  }
  private async call(path: string, body?: URLSearchParams, idempotencyKey?: string) {
    const headers: Record<string, string> = { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` };
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const init: RequestInit = body ? { method: "POST", headers, body } : { method: "GET", headers };
    const res = await withRetry(() => fetch(`https://api.stripe.com/v1/${path}`, init));
    if (!res.ok) throw new Error(`stripe ${path.split("/")[0]} ${res.status}`);
    return res.json() as Promise<{ id: string; client_secret?: string; status?: string }>;
  }
  async createPaymentIntent(i: { orderId: string; money: Money; idempotencyKey: string }) {
    const r = await this.call("payment_intents", new URLSearchParams({ amount: String(i.money.amount), currency: i.money.currency.toLowerCase(), "metadata[orderId]": i.orderId }), i.idempotencyKey);
    return { providerRef: r.id, clientSecret: r.client_secret };
  }
  async retrievePaymentIntent(providerRef: string) {
    if (!/^pi_[A-Za-z0-9_]+$/.test(providerRef)) throw new Error("invalid payment intent id");
    const r = await this.call(`payment_intents/${providerRef}`);
    return { providerRef: r.id, clientSecret: r.client_secret, status: r.status ?? "unknown" };
  }
  async verifyWebhook(rawBody: string, signature: string) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET; if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET missing");
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
    const d = JSON.parse(rawBody) as { id: string; type: string; data: unknown };
    return { eventId: d.id, type: d.type, data: d.data };
  }
  async refund(i: { providerRef: string; money: Money; idempotencyKey: string }) {
    const r = await this.call("refunds", new URLSearchParams({ payment_intent: i.providerRef, amount: String(i.money.amount) }), i.idempotencyKey);
    return { providerRef: r.id };
  }
}
