import type { Redis } from "ioredis";
import { createLoginLimiter, createMfaLimiter } from "../lib/login-limiter.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { usersRepo, recoveryCodesRepo } from "../repositories/users.repository.js";
import { auditRepo } from "../repositories/audit.repository.js";
import { issueSession, verifySession } from "../lib/session.js";
import { SESSION_COOKIE, cookieOptions, emailFingerprint, requireAuth } from "../lib/auth.js";
import { MFA_COOKIE, MFA_TOKEN_TTL_SECONDS, issueMfaToken, verifyMfaToken, type MfaPending } from "../lib/mfa-token.js";
import { registerMfaRoutes, SecondFactor } from "./mfa.js";
import { enrollmentRequired, mfaEnabled, recordFailure, secretBox, verifySecondFactor } from "../services/mfa.service.js";
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

/** The pending-2FA cookie is only ever sent to the auth routes and lives 5 minutes. */
export const mfaCookieOptions = () => ({ ...cookieOptions(), path: "/api/v1/auth", maxAge: MFA_TOKEN_TTL_SECONDS });

declare module "fastify" {
  interface FastifyRequest { mfaPending?: MfaPending }
}


export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Own limiter (lib/login-limiter.ts): @fastify/rate-limit runs one limiter per request, and login needs two windows.
  const checkLogin = createLoginLimiter((app as unknown as { redis?: Redis }).redis,
    { pairMax: 5, pairWindowMs: 60_000, accountMax: LOGIN_ACCOUNT_MAX_PER_HOUR, accountWindowMs: 3_600_000 });
  // Second-factor attempts, per user: 5 per 5 minutes per (user, IP), and at most 20 FAILED codes per 24 hours across all IPs.
  // With 3 valid codes per check (drift window), a guesser who has the password gets about 6e-5 chance per day; every
  // failure is audited and logged (mfa_failed). Successful logins never count toward the daily cap.
  const mfaLimiter = createMfaLimiter((app as unknown as { redis?: Redis }).redis,
    { pairMax: 5, pairWindowMs: 300_000, failureMax: 20, failureWindowMs: 86_400_000 });
  await registerMfaRoutes(app, mfaLimiter);

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
    // The password is correct. Only now may the answer depend on 2FA (it is never revealed to someone without the password).
    if (mfaEnabled(user)) {
      secretBox(); // 503 if the key is missing: fail closed, never fall back to password-only
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.setCookie(MFA_COOKIE, issueMfaToken(user.id, user.sessionVersion, env.SESSION_SECRET), mfaCookieOptions());
      await auditRepo.record({ entity: "User", entityId: user.id, action: "login_mfa_challenge", actor: `user:${user.id}`, after: { ip: req.ip, requestId: req.id } });
      req.log.info({ event: "login_mfa_challenge", userId: user.id }, "password accepted; second factor required");
      return { mfaRequired: true };
    }
    reply.setCookie(SESSION_COOKIE, issueSession({ uid: user.id, role: user.role, tid: user.tenantId, sv: user.sessionVersion }, env.SESSION_SECRET, env.SESSION_TTL_SECONDS), cookieOptions());
    await auditRepo.record({ entity: "User", entityId: user.id, action: "login", actor: `user:${user.id}`, after: { ip: req.ip, requestId: req.id, method: "password" } });
    req.log.info({ event: "login_succeeded", userId: user.id }, "login succeeded");
    return { id: user.id, email: user.email, role: user.role, ...(enrollmentRequired(user) ? { mfaEnrollmentRequired: true } : {}) };
  });

  // Second login step: the `mfa` cookie from a correct password plus a TOTP code or a recovery code.
  r.post("/auth/login/mfa", {
    preHandler: async (req) => {
      const pending = verifyMfaToken(req.cookies[MFA_COOKIE], env.SESSION_SECRET);
      if (!pending) throw new AppError("MFA_CHALLENGE_INVALID", "Sign in again", 401);
      await mfaLimiter.check(pending.uid, req.ip);
      req.mfaPending = pending;
    },
    schema: {
      tags: ["auth"], summary: "Second login step: TOTP code or recovery code after a correct password",
      description: "Requires the httpOnly mfa cookie set by POST /auth/login when it answered { mfaRequired: true } (valid 5 minutes). Send exactly one of code (6 digits) or recoveryCode. Rate-limited per user (5 per 5 minutes per IP, 20 per day). A recovery code works once.",
      body: SecondFactor,
    },
  }, async (req, reply) => {
    const pending = req.mfaPending!;
    const user = await usersRepo.byId(pending.uid);
    if (!user || user.sessionVersion !== pending.sv || !mfaEnabled(user)) {
      reply.clearCookie(MFA_COOKIE, { path: "/api/v1/auth" });
      throw new AppError("MFA_CHALLENGE_INVALID", "Sign in again", 401);
    }
    const method = await verifySecondFactor(user, req.body);
    if (!method) {
      await mfaLimiter.fail(user.id);
      await recordFailure(user.id, "login", "invalid_code", { ip: req.ip, requestId: req.id });
      req.log.warn({ event: "mfa_failed", userId: user.id, ip: req.ip }, "second factor rejected");
      throw new AppError("MFA_INVALID_CODE", "The code is not valid", 401);
    }
    reply.clearCookie(MFA_COOKIE, { path: "/api/v1/auth" });
    reply.setCookie(SESSION_COOKIE, issueSession({ uid: user.id, role: user.role, tid: user.tenantId, sv: user.sessionVersion }, env.SESSION_SECRET, env.SESSION_TTL_SECONDS), cookieOptions());
    await auditRepo.record({ entity: "User", entityId: user.id, action: "login", actor: `user:${user.id}`, after: { ip: req.ip, requestId: req.id, method: `password+${method}` } });
    req.log.info({ event: "login_succeeded", userId: user.id, mfa: method }, "login succeeded");
    const remaining = method === "recovery_code" ? await recoveryCodesRepo.remaining(user.id) : undefined;
    return { id: user.id, email: user.email, role: user.role, ...(remaining !== undefined ? { recoveryCodesRemaining: remaining } : {}) };
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

  r.get("/auth/me", { preHandler: requireAuth(undefined, { allowMfaEnrollment: true }), schema: { tags: ["auth"] } }, async (req) => ({
    id: req.user!.uid, role: req.user!.role, tenantId: req.user!.tid,
    mfaEnabled: req.account!.mfaEnabled, mfaEnrollmentRequired: req.account!.mfaEnrollmentRequired,
  }));
}
