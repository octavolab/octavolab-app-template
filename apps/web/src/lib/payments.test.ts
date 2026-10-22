import { describe, expect, it } from "vitest";
import { paymentMode } from "./payments";

describe("paymentMode (rule N51: never ask for card data in demo)", () => {
  const real = { clientSecret: "pi_3Abc_secret_xyz" };
  it("is demo in fake mode, without a publishable key, or with a fake client secret", () => {
    expect(paymentMode(real, { mode: "fake" }, "pk_test_1")).toBe("demo");
    expect(paymentMode(real, { mode: "sandbox" }, "")).toBe("demo");
    expect(paymentMode({ clientSecret: "fake_pi_o1_secret" }, { mode: "sandbox" }, "pk_test_1")).toBe("demo");
    expect(paymentMode({}, { mode: "live" }, "pk_live_1")).toBe("demo");
    expect(paymentMode(real, null, "pk_test_1")).toBe("demo");
  });
  it("mounts Stripe only with a real secret, a publishable key and a non-fake mode", () => {
    expect(paymentMode(real, { mode: "sandbox" }, "pk_test_1")).toBe("stripe");
  });
  it("follows the payments mode, not the global default (PAYMENTS_MODE=sandbox with INTEGRATIONS_MODE=fake on staging)", () => {
    const modes = (payments: "fake" | "sandbox" | "live") => ({ payments, messaging: "fake" as const, carrier: "fake" as const, storage: "fake" as const });
    expect(paymentMode(real, { mode: "fake", modes: modes("sandbox") }, "pk_test_1")).toBe("stripe");
    expect(paymentMode(real, { mode: "sandbox", modes: modes("fake") }, "pk_test_1")).toBe("demo");
  });
});
