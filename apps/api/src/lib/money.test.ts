import { describe, it, expect } from "vitest";
import { add, assertMoney } from "./money.js";
describe("money", () => {
  it("adds same currency", () => expect(add({ amount: 100, currency: "USD" }, { amount: 50, currency: "USD" })).toEqual({ amount: 150, currency: "USD" }));
  it("rejects mixed currency", () => expect(() => add({ amount: 1, currency: "USD" }, { amount: 1, currency: "GBP" })).toThrow());
  it("rejects decimals", () => expect(() => assertMoney({ amount: 1.5, currency: "USD" })).toThrow());
});
