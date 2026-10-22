import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { prisma } from "@octavolab/db";
import { getPayments } from "@octavolab/integrations";
import { APP_VERSION, env } from "../config/env.js";

/** Payments probe result is cached this long: Lightsail and the container HEALTHCHECK poll every 30 s each. */
export const PAYMENTS_PROBE_TTL_MS = 60_000;
/** The health answer never waits longer than this for the provider: a slow Stripe must not make Lightsail recycle a healthy container. */
export const PAYMENTS_PROBE_WAIT_MS = 1_000;
type ProbeState = "ok" | "degraded";
let paymentsProbe: { at: number; result: Promise<ProbeState> } | undefined;

/**
 * Payments health: a cheap authenticated provider call (Stripe `GET /v1/balance`), at most once per 60 s per process.
 * Concurrent probes share one in-flight call. Any failure (network, 401, misconfiguration) is `degraded`; the reason is
 * logged without secrets and never returned to the caller.
 */
export function probePayments(log: { warn(o: object, msg: string): void }, now = Date.now()): Promise<ProbeState> {
  if (paymentsProbe && now - paymentsProbe.at < PAYMENTS_PROBE_TTL_MS) return paymentsProbe.result;
  const result = (async (): Promise<ProbeState> => {
    try { await getPayments().ping(); return "ok"; } catch (e) {
      log.warn({ event: "payments_probe_failed", error: e instanceof Error ? e.message : "unknown" }, "payments health probe failed");
      return "degraded";
    }
  })();
  paymentsProbe = { at: now, result };
  return result;
}
export function resetPaymentsProbe() { paymentsProbe = undefined; }

/** The probe result, or `degraded` if it is not available within `waitMs` (the probe keeps running and fills the cache). */
export async function paymentsHealth(log: { warn(o: object, msg: string): void }, waitMs = PAYMENTS_PROBE_WAIT_MS): Promise<ProbeState> {
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<ProbeState>((resolve) => { timer = setTimeout(() => resolve("degraded"), waitMs); });
  try { return await Promise.race([probePayments(log), slow]); } finally { clearTimeout(timer); }
}

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", { config: { rateLimit: false } }, async (req, reply) => {
    let db = "ok";
    try { await prisma.$queryRaw`SELECT 1`; } catch { db = "down"; }
    // Redis is optional; when configured, its state is reported so a Redis outage is visible (rate limits fail open, login fails closed).
    const redis = (app as unknown as { redis?: Redis }).redis;
    let cache: "ok" | "down" | "not_configured" = "not_configured";
    if (redis) { try { cache = (await redis.ping()) === "PONG" ? "ok" : "down"; } catch { cache = "down"; } }
    // A payments outage degrades the service but must not fail the probe: Lightsail would recycle healthy containers.
    const payments = await paymentsHealth(req.log);
    reply.code(db === "ok" ? 200 : 503);
    return { ok: db === "ok", version: APP_VERSION, mode: env.INTEGRATIONS_MODE, modes: env.MODES, deps: { db, redis: cache, payments } };
  });
}
