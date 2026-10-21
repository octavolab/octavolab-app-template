import type { Redis } from "ioredis";
import { createLoginLimiter } from "../lib/login-limiter.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { usersRepo } from "../repositories/users.repository.js";
import { auditRepo } from "../repositories/audit.repository.js";
import { issueSession, verifySession } from "../lib/session.js";
import { SESSION_COOKIE, cookieOptions, emailFingerprint, requireAuth } from "../lib/auth.js";
import { AppError } from "../lib/errors.js";
import { env } from "../config/env.js";

// A real argon2id hash computed once at start-up and verified against when the email does not exist,
// so the response time does not reveal which emails are registered.
const DUMMY_HASH = argon2.hash(randomUUID());

/** Login attempts are counted per account AND client IP: an attacker cannot lock a victim out from another IP. */
export const loginRateKey = (email: string | undefined, ip: string) => `login:${String(email ?? "").trim().toLowerCase()}:${ip}`;

/** Soft per-account cap across all IPs: stops distributed guessing against one account; recovers by itself after the window. */
export const loginAccountKey = (email: string | undefined) => `login-acct:${String(email ?? "").trim().toLowerCase()}`;
export const LOGIN_ACCOUNT_MAX_PER_HOUR = 30;

export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Own limiter (lib/login-limiter.ts): @fastify/rate-limit runs one limiter per request, and login needs two windows.
  const checkLogin = createLoginLimiter((app as unknown as { redis?: Redis }).redis,
    { pairMax: 5, pairWindowMs: 60_000, accountMax: LOGIN_ACCOUNT_MAX_PER_HOUR, accountWindowMs: 3_600_000 });

  r.post("/auth/login", {
    // 5 attempts per minute per (email, IP) pair, plus a soft cap of 30 per hour per account across all IPs; both fail closed if Redis is down.
    preHandler: async (req) => { await checkLogin((req.body as { email?: string } | undefined)?.email, req.ip); },
    schema: { tags: ["auth"], body: z.object({ email: z.string().email().max(254), password: z.string().min(8).max(200) }) },
  }, async (req, reply) => {
    const user = await usersRepo.byEmail(req.body.email);
    const ok = await argon2.verify(user?.passwordHash ?? (await DUMMY_HASH), req.body.password).catch(() => false);
    if (!user || !ok) {
      // ASVS 7.2.1: failed authentication is logged with a keyed email fingerprint, never the email or the password.
      req.log.warn({ event: "login_failed", emailHash: emailFingerprint(req.body.email), reason: user ? "bad_password" : "unknown_account", ip: req.ip }, "login failed");
      throw new AppError("INVALID_CREDENTIALS", "Email or password is incorrect", 401);
    }
    reply.setCookie(SESSION_COOKIE, issueSession({ uid: user.id, role: user.role, tid: user.tenantId, sv: user.sessionVersion }, env.SESSION_SECRET, env.SESSION_TTL_SECONDS), cookieOptions());
    await auditRepo.record({ entity: "User", entityId: user.id, action: "login", actor: `user:${user.id}`, after: { ip: req.ip, requestId: req.id } });
    req.log.info({ event: "login_succeeded", userId: user.id }, "login succeeded");
    return { id: user.id, email: user.email, role: user.role };
  });

  // Logout revokes every session of the user server-side (sessionVersion + 1), then clears the cookie.
  r.post("/auth/logout", { schema: { tags: ["auth"] } }, async (req, reply) => {
    const s = verifySession(req.cookies[SESSION_COOKIE], env.SESSION_SECRET);
    if (s) {
      await usersRepo.revokeSessions(s.uid);
      await auditRepo.record({ entity: "User", entityId: s.uid, action: "logout", actor: `user:${s.uid}`, after: { ip: req.ip, requestId: req.id } });
      req.log.info({ event: "logout", userId: s.uid }, "logout");
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  r.get("/auth/me", { preHandler: requireAuth(), schema: { tags: ["auth"] } }, async (req) => ({ id: req.user!.uid, role: req.user!.role, tenantId: req.user!.tid }));
}
