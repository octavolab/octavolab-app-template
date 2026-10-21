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
  private async call(path: string, body: URLSearchParams, idempotencyKey?: string) {
    const headers: Record<string, string> = { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await withRetry(() => fetch(`https://api.stripe.com/v1/${path}`, { method: "POST", headers, body }));
    if (!res.ok) throw new Error(`stripe ${path} ${res.status}`);
    return res.json() as Promise<{ id: string; client_secret?: string }>;
  }
  async createPaymentIntent(i: { orderId: string; money: Money; idempotencyKey: string }) {
    const r = await this.call("payment_intents", new URLSearchParams({ amount: String(i.money.amount), currency: i.money.currency.toLowerCase(), "metadata[orderId]": i.orderId }), i.idempotencyKey);
    return { providerRef: r.id, clientSecret: r.client_secret };
  }
  async verifyWebhook(rawBody: string, signature: string) {
    // Implement signature verification with STRIPE_WEBHOOK_SECRET (HMAC SHA-256 over `${t}.${rawBody}`) before enabling live mode.
    if (!signature) throw new Error("missing signature");
    const d = JSON.parse(rawBody) as { id: string; type: string; data: unknown };
    return { eventId: d.id, type: d.type, data: d.data };
  }
  async refund(i: { providerRef: string; money: Money; idempotencyKey: string }) {
    const r = await this.call("refunds", new URLSearchParams({ payment_intent: i.providerRef, amount: String(i.money.amount) }), i.idempotencyKey);
    return { providerRef: r.id };
  }
}
