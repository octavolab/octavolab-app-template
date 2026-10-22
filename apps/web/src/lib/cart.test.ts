import { describe, expect, it } from "vitest";
import { addOne, setQty, summarize, MAX_QTY } from "./cart";
import type { Product } from "./api";

const p = (sku: string, unitAmount: number, currency = "GBP", active = true): Product =>
  ({ id: sku, sku, name: sku, unitAmount, currency, active, createdAt: "", updatedAt: "" });

describe("cart", () => {
  it("adds, updates, clamps and removes lines", () => {
    let c = addOne([], "A");
    c = addOne(c, "A");
    expect(c).toEqual([{ sku: "A", qty: 2 }]);
    expect(setQty(c, "A", MAX_QTY + 5)).toEqual([{ sku: "A", qty: MAX_QTY }]);
    expect(setQty(c, "A", 0)).toEqual([]);
  });
  it("totals in minor units per currency and flags mixed currencies and unavailable items", () => {
    const s = summarize([{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }], [p("A", 1500), p("B", 3900)]);
    expect(s).toEqual({ count: 3, totals: [{ currency: "GBP", amount: 6900 }], mixedCurrency: false, unavailable: [] });
    expect(summarize([{ sku: "A", qty: 1 }, { sku: "C", qty: 1 }], [p("A", 1), p("C", 1, "USD")]).mixedCurrency).toBe(true);
    expect(summarize([{ sku: "X", qty: 1 }], [p("X", 1, "GBP", false)]).unavailable).toEqual(["X"]);
  });
});
