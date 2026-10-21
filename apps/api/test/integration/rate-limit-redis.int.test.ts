/**
 * Rate limiting with the Redis store (REDIS_URL set): counters are shared by every API instance.
 * Runs with INTEGRATION=1 in CI (Redis service container). Skipped when REDIS_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const run = process.env.INTEGRATION === "1" && !!process.env.REDIS_URL;

describe.runIf(run)("login rate limit shared through Redis", () => {
  let a: any, b: any, redis: any;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: "test", SESSION_SECRET: process.env.SESSION_SECRET ?? "s".repeat(40), APP_URL: process.env.APP_URL ?? "http://localhost:5173", OPS_EMAIL: process.env.OPS_EMAIL ?? "ops@ci.invalid" });
    const { Redis } = await import("ioredis");
    redis = new Redis(process.env.REDIS_URL!);
    await redis.flushdb();
    const { buildApp } = await import("../../src/app.js");
    a = await buildApp();
    b = await buildApp(); // a second API instance with its own process memory
  });
  afterAll(async () => { await a?.close(); await b?.close(); await redis?.quit(); });

  it("counts attempts across instances and stores the counters in Redis", async () => {
    const attempt = (app: any) => app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": "10.9.9.9" }, payload: { email: "redis-rl@a.co", password: "wrong-password-x" } });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await attempt(a)).statusCode);
    for (let i = 0; i < 3; i++) codes.push((await attempt(b)).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429); // the sixth attempt hits the shared counter even though it went to another instance
    expect((await redis.keys("rl:*")).length).toBeGreaterThan(0);
  });
});
