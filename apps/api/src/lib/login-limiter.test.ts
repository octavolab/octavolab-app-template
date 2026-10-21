import { describe, it, expect } from "vitest";
import type { Redis } from "ioredis";
import { createMfaLimiter } from "./login-limiter.js";

const limits = { pairMax: 5, pairWindowMs: 300_000, failureMax: 20, failureWindowMs: 86_400_000 };

describe("MFA limiter (memory store)", () => {
  it("allows 5 attempts per (user, IP) per window, then 429; other IPs and users are unaffected", async () => {
    const l = createMfaLimiter(undefined, limits);
    for (let i = 0; i < 5; i++) await l.check("u1", "1.1.1.1");
    await expect(l.check("u1", "1.1.1.1")).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    await expect(l.check("u1", "2.2.2.2")).resolves.toBeUndefined();
    await expect(l.check("u2", "1.1.1.1")).resolves.toBeUndefined();
  });

  it("caps FAILED codes per user across all IPs at 20 per day; successful attempts never count", async () => {
    const l = createMfaLimiter(undefined, limits);
    for (let i = 0; i < 40; i++) await l.check("ok-user", `10.0.${i}.1`); // 40 successful logins from 40 IPs: never blocked
    for (let i = 0; i < 20; i++) { await l.check("victim", `10.1.${i}.1`); await l.fail("victim"); }
    await expect(l.check("victim", "10.9.9.9")).rejects.toMatchObject({ status: 429 });
    await expect(l.check("ok-user", "10.9.9.9")).resolves.toBeUndefined();
  });

  it("fails closed when Redis is configured but unreachable", async () => {
    const broken = { multi: () => { throw new Error("ECONNREFUSED"); }, get: async () => { throw new Error("ECONNREFUSED"); } } as unknown as Redis;
    await expect(createMfaLimiter(broken, limits).check("u1", "1.1.1.1")).rejects.toMatchObject({ status: 429 });
  });
});
