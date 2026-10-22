import type { PaymentGateway, CarrierRates, MessagingProvider, MessageInput, Money } from "./contracts.js";
/** Fake adapters: used in demos, tests and local dev. Never in production (N51). */
export class FakePayments implements PaymentGateway {
  name = "fake-payments";
  async createPaymentIntent(i: { orderId: string; money: Money; idempotencyKey: string }) { return { providerRef: `fake_pi_${i.orderId}`, clientSecret: `fake_pi_${i.orderId}_secret` }; }
  async retrievePaymentIntent(providerRef: string) { return { providerRef, clientSecret: `${providerRef}_secret`, status: "requires_payment_method" }; }
  /** Same event shape as Stripe ({ id, type, data: { object } }); unsigned, so the API closes this route in production. */
  async verifyWebhook(rawBody: string, _signature: string) { const d = JSON.parse(rawBody); return { eventId: d.id ?? "evt_fake", type: d.type ?? "payment.succeeded", data: d.data ?? d }; }
  async refund(i: { providerRef: string; money: Money; idempotencyKey: string }) { return { providerRef: `${i.providerRef}_refund` }; }
  async ping() { /* always healthy */ }
}
export class FakeCarrier implements CarrierRates {
  name = "fake-carrier";
  async quote(i: { from: string; to: string; weightKg: number; volumetricKg: number }) {
    const billable = Math.max(i.weightKg, i.volumetricKg);
    return [{ carrier: "DemoExpress", service: "Standard", money: { amount: Math.round(billable * 1250), currency: "USD" }, etaDays: 5 }];
  }
}
export class FakeMessaging implements MessagingProvider {
  name = "fake-messaging";
  async send(_i: MessageInput) { return { providerRef: `fake_msg_${Date.now()}` }; }
}
