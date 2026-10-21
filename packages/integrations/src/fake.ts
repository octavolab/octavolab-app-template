import type { PaymentGateway, CarrierRates, MessagingProvider } from "./contracts.js";
/** Fake adapters: used in demos, tests and local dev. Never in production (N51). */
export class FakePayments implements PaymentGateway {
  name = "fake-payments";
  async createPaymentIntent(i: { orderId: string }) { return { providerRef: `fake_pi_${i.orderId}` }; }
  async verifyWebhook(rawBody: string) { const d = JSON.parse(rawBody); return { eventId: d.id ?? "evt_fake", type: d.type ?? "payment.succeeded", data: d }; }
  async refund(i: { providerRef: string }) { return { providerRef: `${i.providerRef}_refund` }; }
}
export class FakeCarrier implements CarrierRates {
  name = "fake-carrier";
  async quote(i: { weightKg: number; volumetricKg: number }) {
    const billable = Math.max(i.weightKg, i.volumetricKg);
    return [{ carrier: "DemoExpress", service: "Standard", money: { amount: Math.round(billable * 1250), currency: "USD" }, etaDays: 5 }];
  }
}
export class FakeMessaging implements MessagingProvider {
  name = "fake-messaging";
  async send() { return { providerRef: `fake_msg_${Date.now()}` }; }
}
