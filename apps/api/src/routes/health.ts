import type { FastifyInstance } from "fastify";
import { prisma } from "@octavolab/db";
import { APP_VERSION, env } from "../config/env.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    let db = "ok";
    try { await prisma.$queryRaw`SELECT 1`; } catch { db = "down"; }
    return { ok: db === "ok", version: APP_VERSION, mode: env.INTEGRATIONS_MODE, deps: { db } };
  });
}
