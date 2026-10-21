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
  it("refuses live mode with a test key", () => {
    expect(() => new StripeGateway(true)).toThrow("live mode requires a live key");
  });
});
