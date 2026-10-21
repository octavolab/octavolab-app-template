import type { Redis } from "ioredis";
import { AppError } from "./errors.js";

/**
 * Login limiter with two fixed windows, checked on every attempt after body parsing:
 *  - per (email, IP): stops one source hammering one account;
 *  - per account across all IPs: a soft cap that stops distributed guessing and recovers by itself.
 * Uses Redis when configured (shared by every API instance) and process memory otherwise (single instance only).
 * Fails closed: if Redis is configured but unreachable, login answers 429 instead of skipping the check.
 */
export type LoginLimits = { pairMax: number; pairWindowMs: number; accountMax: number; accountWindowMs: number };

const MAX_KEYS = 50_000;

export function createLoginLimiter(redis: Redis | undefined, limits: LoginLimits) {
  const mem = new Map<string, { count: number; resetAt: number }>();

  async function hit(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    if (redis) {
      const res = await redis.multi().incr(key).pexpire(key, windowMs, "NX").pttl(key).exec();
      if (!res) throw new Error("redis transaction aborted");
      return { count: Number(res[0]?.[1] ?? 0), ttlMs: Number(res[2]?.[1] ?? windowMs) };
    }
    const now = Date.now();
    // Bound memory in single-instance mode: sweep expired windows when the map grows; if still full, fail closed.
    if (mem.size > MAX_KEYS) for (const [k, v] of mem) if (v.resetAt <= now) mem.delete(k);
    if (mem.size > MAX_KEYS && !mem.has(key)) throw new Error("login limiter memory full");
    const cur = mem.get(key);
    if (!cur || cur.resetAt <= now) { mem.set(key, { count: 1, resetAt: now + windowMs }); return { count: 1, ttlMs: windowMs }; }
    cur.count += 1;
    return { count: cur.count, ttlMs: cur.resetAt - now };
  }

  return async function check(email: string | undefined, ip: string): Promise<void> {
    const acct = String(email ?? "").trim().toLowerCase();
    let pair: { count: number; ttlMs: number }, account: { count: number; ttlMs: number };
    try {
      pair = await hit(`login:${acct}:${ip}`, limits.pairWindowMs);
      account = await hit(`login-acct:${acct}`, limits.accountWindowMs);
    } catch {
      throw new AppError("RATE_LIMITED", "Too many login attempts, try again later", 429);
    }
    if (pair.count > limits.pairMax || account.count > limits.accountMax) {
      throw new AppError("RATE_LIMITED", "Too many login attempts, try again later", 429);
    }
  };
}
