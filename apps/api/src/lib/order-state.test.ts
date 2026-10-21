import { describe, it, expect } from "vitest";
import { canTransition, sourcesOf, type OrderStatus } from "./order-state.js";

const all: OrderStatus[] = ["draft", "confirmed", "paid", "shipped", "delivered", "closed", "cancelled", "refunded"];

describe("order state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("draft", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "paid")).toBe(true);
    expect(canTransition("paid", "shipped")).toBe(true);
    expect(canTransition("shipped", "delivered")).toBe(true);
    expect(canTransition("delivered", "closed")).toBe(true);
  });
  it("rejects skipping or going backwards", () => {
    expect(canTransition("draft", "paid")).toBe(false);
    expect(canTransition("shipped", "paid")).toBe(false);
    expect(canTransition("paid", "draft")).toBe(false);
  });
  it("terminal states have no exits", () => {
    for (const t of all) {
      expect(canTransition("closed", t)).toBe(false);
      expect(canTransition("cancelled", t)).toBe(false);
      expect(canTransition("refunded", t)).toBe(false);
    }
  });
  it("sourcesOf is the inverse of canTransition", () => {
    for (const to of all) for (const from of all) expect(sourcesOf(to).includes(from)).toBe(canTransition(from, to));
  });
});
