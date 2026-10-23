import { describe, expect, it } from "vitest";
import { paymentMode } from "./payments";

describe("paymentMode (rule N51: never ask for card data in demo)", () => {
  const real = { clientSecret: "pi_3Abc_secret_xyz" };
  it("is demo in fake mode, without a publishable key, or with a fake client secret", () => {
    expect(paymentMode(real, { mode: "fake" }, "pk_test_1")).toBe("demo");
    expect(paymentMode(real, { mode: "test" }, "")).toBe("demo");
    expect(paymentMode({ clientSecret: "fake_pi_o1_secret" }, { mode: "test" }, "pk_test_1")).toBe("demo");
    expect(paymentMode({}, { mode: "live" }, "pk_live_1")).toBe("demo");
    expect(paymentMode(real, null, "pk_test_1")).toBe("demo");
  });
  it("mounts Stripe only with a real secret, a publishable key and a non-fake mode", () => {
    expect(paymentMode(real, { mode: "test" }, "pk_test_1")).toBe("stripe");
  });
});
