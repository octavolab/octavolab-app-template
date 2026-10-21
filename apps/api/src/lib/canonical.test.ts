import { describe, it, expect } from "vitest";
import { canonicalJson, requestHash } from "./canonical.js";

describe("canonical JSON and request hash", () => {
  it("ignores key order at every depth but keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
    expect(requestHash("op", { a: 1, b: { c: 2 } })).toBe(requestHash("op", { b: { c: 2 }, a: 1 }));
    expect(requestHash("op", { items: [1, 2] })).not.toBe(requestHash("op", { items: [2, 1] }));
  });
  it("drops undefined members like JSON.stringify and handles primitives", () => {
    expect(canonicalJson({ a: undefined, b: "x" })).toBe('{"b":"x"}');
    expect(canonicalJson([undefined, true])).toBe("[null,true]");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(3)).toBe("3");
  });
  it("binds the hash to the operation as well as the input", () => {
    expect(requestHash("orders.create", { a: 1 })).not.toBe(requestHash("orders.checkout", { a: 1 }));
    expect(requestHash("op", { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
