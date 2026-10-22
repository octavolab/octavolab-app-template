import { describe, it, expect, vi } from "vitest";
import type { Redis } from "ioredis";
import { createLoginLimiter, createMfaLimiter } from "./login-limiter.js";

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

/** Minimal Redis double: the MULTI chain the limiter uses (INCR, PEXPIRE NX, PTTL) plus GET, with real TTLs. */
function fakeRedis(opts: { abort?: boolean } = {}) {
  const data = new Map<string, { v: number; exp: number }>();
  const live = (k: string) => { const e = data.get(k); return e && e.exp > Date.now() ? e : undefined; };
  return {
    multi() {
      const ops: Array<() => unknown> = [];
      const chain = {
        incr(k: string) { ops.push(() => { const e = live(k); const v = (e?.v ?? 0) + 1; data.set(k, { v, exp: e?.exp ?? Infinity }); return v; }); return chain; },
        pexpire(k: string, ms: number) { ops.push(() => { const e = data.get(k)!; if (e.exp === Infinity) { e.exp = Date.now() + ms; return 1; } return 0; }); return chain; },
        pttl(k: string) { ops.push(() => { const e = live(k); return e ? e.exp - Date.now() : -2; }); return chain; },
        async exec() { return opts.abort ? null : ops.map((op) => [null, op()]); },
      };
      return chain;
    },
    async get(k: string) { const e = live(k); return e ? String(e.v) : null; },
  } as unknown as Redis;
}

describe("login and MFA limiters (Redis store)", () => {
  const loginLimits = { pairMax: 5, pairWindowMs: 60_000, accountMax: 30, accountWindowMs: 3_600_000 };

  it("counts login attempts in Redis, shared by every instance using the same Redis", async () => {
    const redis = fakeRedis();
    const a = createLoginLimiter(redis, loginLimits);
    const b = createLoginLimiter(redis, loginLimits); // a second container behind the load balancer
    for (let i = 0; i < 3; i++) await a(" Ana@A.co ", "1.1.1.1");
    for (let i = 0; i < 2; i++) await b("ana@a.co", "1.1.1.1");
    await expect(a("ana@a.co", "1.1.1.1")).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    await expect(b(undefined, "9.9.9.9")).resolves.toBeUndefined();
  });

  it("caps attempts per account across IPs", async () => {
    const check = createLoginLimiter(fakeRedis(), { ...loginLimits, accountMax: 3 });
    for (let i = 0; i < 3; i++) await check("bob@a.co", `10.0.0.${i}`);
    await expect(check("bob@a.co", "10.0.0.99")).rejects.toMatchObject({ status: 429 });
  });

  it("fails closed when the Redis transaction is aborted", async () => {
    await expect(createLoginLimiter(fakeRedis({ abort: true }), loginLimits)("ana@a.co", "1.1.1.1")).rejects.toMatchObject({ status: 429 });
    await expect(createMfaLimiter(fakeRedis({ abort: true }), limits).check("u1", "1.1.1.1")).rejects.toMatchObject({ status: 429 });
  });

  it("reads MFA failures from Redis and blocks at the daily cap", async () => {
    const l = createMfaLimiter(fakeRedis(), { ...limits, failureMax: 2 });
    await l.check("u1", "1.1.1.1"); await l.fail("u1");
    await l.check("u1", "1.1.1.2"); await l.fail("u1");
    await expect(l.check("u1", "1.1.1.3")).rejects.toMatchObject({ status: 429 });
  });

  it("a recording failure in Redis never breaks the login flow (the pair window still applies)", async () => {
    await expect(createMfaLimiter(fakeRedis({ abort: true }), limits).fail("u1")).resolves.toBeUndefined();
  });
});

describe("memory store bounds", () => {
  it("starts a new window after expiry and fails closed when 50,000 live keys are held", async () => {
    vi.useFakeTimers();
    try {
      const check = createLoginLimiter(undefined, { pairMax: 1, pairWindowMs: 1_000, accountMax: 1_000_000, accountWindowMs: 1_000 });
      await check("a@a.co", "1.1.1.1");
      await expect(check("a@a.co", "1.1.1.1")).rejects.toMatchObject({ status: 429 });
      vi.advanceTimersByTime(1_001);
      await expect(check("a@a.co", "1.1.1.1")).resolves.toBeUndefined(); // expired window: counting restarts
      for (let i = 0; i < 24_999; i++) await check(`u${i}@a.co`, "2.2.2.2"); // 2 keys each (pair + account): 50,000 held
      await expect(check("new@a.co", "3.3.3.3")).rejects.toMatchObject({ status: 429 }); // full: fail closed
      vi.advanceTimersByTime(1_001);
      await expect(check("new@a.co", "3.3.3.3")).resolves.toBeUndefined(); // expired keys are swept
    } finally { vi.useRealTimers(); }
  });

  it("MFA failures in memory expire with their window", async () => {
    vi.useFakeTimers();
    try {
      const l = createMfaLimiter(undefined, { ...limits, failureMax: 1, failureWindowMs: 1_000 });
      await l.fail("u9");
      await expect(l.check("u9", "1.1.1.1")).rejects.toMatchObject({ status: 429 });
      vi.advanceTimersByTime(1_001);
      await expect(l.check("u9", "1.1.1.1")).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});
