import { describe, it, expect } from "vitest";
import { canTransition, sourcesOf, type OrderStatus } from "./order-state.js";

const all: OrderStatus[] = ["draft", "confirmed", "pending_payment", "paid", "shipped", "delivered", "closed", "cancelled", "refunded"];

describe("order state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("draft", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "paid")).toBe(true);
    expect(canTransition("paid", "shipped")).toBe(true);
    expect(canTransition("shipped", "delivered")).toBe(true);
    expect(canTransition("delivered", "closed")).toBe(true);
  });
  it("allows the checkout path and nothing else out of pending_payment", () => {
    expect(canTransition("draft", "pending_payment")).toBe(true);
    expect(canTransition("pending_payment", "paid")).toBe(true);
    expect(canTransition("pending_payment", "cancelled")).toBe(true);
    expect(canTransition("pending_payment", "draft")).toBe(false);
    expect(canTransition("pending_payment", "shipped")).toBe(false);
    expect(canTransition("paid", "pending_payment")).toBe(false);
    expect(sourcesOf("paid").sort()).toEqual(["confirmed", "pending_payment"]);
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
