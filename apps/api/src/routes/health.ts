import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { prisma } from "@octavolab/db";
import { APP_VERSION, env } from "../config/env.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", { config: { rateLimit: false } }, async (_req, reply) => {
    let db = "ok";
    try { await prisma.$queryRaw`SELECT 1`; } catch { db = "down"; }
    // Redis is optional; when configured, its state is reported so a Redis outage is visible (rate limits fail open, login fails closed).
    const redis = (app as unknown as { redis?: Redis }).redis;
    let cache: "ok" | "down" | "not_configured" = "not_configured";
    if (redis) { try { cache = (await redis.ping()) === "PONG" ? "ok" : "down"; } catch { cache = "down"; } }
    reply.code(db === "ok" ? 200 : 503);
    return { ok: db === "ok", version: APP_VERSION, mode: env.INTEGRATIONS_MODE, deps: { db, redis: cache } };
  });
}
