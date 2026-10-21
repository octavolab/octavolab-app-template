import type { FastifyInstance } from "fastify";
import { prisma } from "@octavolab/db";
import { APP_VERSION, env } from "../config/env.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", { config: { rateLimit: false } }, async (_req, reply) => {
    let db = "ok";
    try { await prisma.$queryRaw`SELECT 1`; } catch { db = "down"; }
    reply.code(db === "ok" ? 200 : 503);
    return { ok: db === "ok", version: APP_VERSION, mode: env.INTEGRATIONS_MODE, deps: { db } };
  });
}
