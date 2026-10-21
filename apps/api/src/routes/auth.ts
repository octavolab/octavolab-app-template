import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { usersRepo } from "../repositories/users.repository.js";
import { issueSession } from "../lib/session.js";
import { SESSION_COOKIE, cookieOptions, requireAuth } from "../lib/auth.js";
import { AppError } from "../lib/errors.js";
import { env } from "../config/env.js";

// A real argon2id hash computed once at start-up and verified against when the email does not exist,
// so the response time does not reveal which emails are registered.
const DUMMY_HASH = argon2.hash(randomUUID());

export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/auth/login", {
    // 5 attempts per minute per IP and email: brute force on one account is stopped without locking out a whole office behind one IP.
    config: { rateLimit: { max: 5, timeWindow: "1 minute", hook: "preHandler", keyGenerator: (req) => `${req.ip}:${String((req.body as { email?: string } | undefined)?.email ?? "").toLowerCase()}` } },
    schema: { body: z.object({ email: z.string().email().max(254), password: z.string().min(8).max(200) }) },
  }, async (req, reply) => {
    const user = await usersRepo.byEmail(req.body.email);
    const ok = await argon2.verify(user?.passwordHash ?? (await DUMMY_HASH), req.body.password).catch(() => false);
    if (!user || !ok) throw new AppError("INVALID_CREDENTIALS", "Email or password is incorrect", 401);
    reply.setCookie(SESSION_COOKIE, issueSession({ uid: user.id, role: user.role, tid: user.tenantId }, env.SESSION_SECRET, env.SESSION_TTL_SECONDS), cookieOptions());
    return { id: user.id, email: user.email, role: user.role };
  });

  r.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  r.get("/auth/me", { preHandler: requireAuth() }, async (req) => ({ id: req.user!.uid, role: req.user!.role, tenantId: req.user!.tid }));
}
