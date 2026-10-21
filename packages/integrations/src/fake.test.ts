import { describe, it, expect } from "vitest";
import { FakeCarrier } from "./fake.js";
describe("FakeCarrier", () => {
  it("bills the greater of real and volumetric weight", async () => {
    const [q] = await new FakeCarrier().quote({ from: "GB", to: "CO", weightKg: 2, volumetricKg: 5 });
    expect(q?.money.amount).toBe(6250);
  });
});
import { FakePayments } from "./fake.js";
describe("FakePayments", () => {
  it("returns Stripe-shaped webhook data ({ object }) and deterministic intents", async () => {
    const ev = await new FakePayments().verifyWebhook(JSON.stringify({ id: "evt_f", type: "payment_intent.succeeded", data: { object: { id: "fake_pi_o1" } } }), "");
    expect(ev).toEqual({ eventId: "evt_f", type: "payment_intent.succeeded", data: { object: { id: "fake_pi_o1" } } });
    const p = new FakePayments();
    expect((await p.createPaymentIntent({ orderId: "o1", money: { amount: 1, currency: "USD" }, idempotencyKey: "k" })).providerRef).toBe("fake_pi_o1");
    expect((await p.retrievePaymentIntent("fake_pi_o1")).clientSecret).toBe("fake_pi_o1_secret");
  });
});
