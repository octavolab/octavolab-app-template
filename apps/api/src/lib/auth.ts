import type { FastifyReply, FastifyRequest } from "fastify";
import { createHmac } from "node:crypto";
import { verifySession, issueSession, needsRotation, type Session } from "./session.js";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";
import { usersRepo } from "../repositories/users.repository.js";
import { enrollmentRequired, mfaEnabled } from "../services/mfa.service.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: Session;
    /** The account re-read from the database by requireAuth (never from the token). */
    account?: { id: string; email: string; mfaEnabled: boolean; mfaEnrollmentRequired: boolean };
  }
}

export const SESSION_COOKIE = "sid";
export const cookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: env.SESSION_TTL_SECONDS,
});

/**
 * Keyed, non-reversible fingerprint of an email for security logs (ASVS 7.1.1: no personal data in logs).
 * HMAC rather than a bare hash so a leaked log cannot be matched against a list of known emails.
 */
export function emailFingerprint(email: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(`log:email:${email.trim().toLowerCase()}`).digest("hex").slice(0, 16);
}

/**
 * preHandler: requires a valid session and, optionally, one of the roles.
 * On every authenticated request the user is re-read by primary key: the token is rejected (401) if the user no longer
 * exists, its sessionVersion changed (logout, role change) or its role or tenant differ from the token. The cookie is
 * rotated after half its life, carrying the current sessionVersion.
 * With REQUIRE_PRIVILEGED_2FA=true an owner or admin without 2FA gets 403 MFA_ENROLLMENT_REQUIRED on every route that does not pass
 * `allowMfaEnrollment` (only /auth/me and the /auth/2fa enrollment routes do).
 */
export function requireAuth(roles?: Session["role"][], opts: { allowMfaEnrollment?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const s = verifySession(req.cookies[SESSION_COOKIE], env.SESSION_SECRET);
    if (!s) throw new AppError("UNAUTHENTICATED", "Sign in required", 401);
    const user = await usersRepo.byId(s.uid);
    if (!user || user.sessionVersion !== s.sv || user.role !== s.role || (user.tenantId ?? null) !== s.tid) {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      throw new AppError("SESSION_REVOKED", "Sign in again", 401);
    }
    const mustEnroll = enrollmentRequired(user);
    if (mustEnroll && !opts.allowMfaEnrollment) throw new AppError("MFA_ENROLLMENT_REQUIRED", "Set up two-factor authentication first", 403);
    if (roles && !roles.includes(s.role)) throw new AppError("FORBIDDEN", "Not allowed", 403);
    if (needsRotation(s, env.SESSION_TTL_SECONDS)) {
      reply.setCookie(SESSION_COOKIE, issueSession({ uid: s.uid, role: s.role, tid: s.tid, sv: s.sv, auth: s.auth }, env.SESSION_SECRET, env.SESSION_TTL_SECONDS), cookieOptions());
    }
    req.user = s;
    req.account = { id: user.id, email: user.email, mfaEnabled: mfaEnabled(user), mfaEnrollmentRequired: mustEnroll };
  };
}

/** Tenant-scoped routes: a user without a tenant is never treated as a shared tenant (403). */
export function tenantOf(req: FastifyRequest): string {
  const tid = req.user?.tid;
  if (!tid) throw new AppError("TENANT_REQUIRED", "This action requires a tenant", 403);
  return tid;
}

/** Re-issues the caller's session cookie with a new sessionVersion (after a 2FA change revoked the old ones), keeping the sign-in time. */
export function reissueSession(reply: FastifyReply, s: Session, sv: number) {
  reply.setCookie(SESSION_COOKIE, issueSession({ uid: s.uid, role: s.role, tid: s.tid, sv, auth: s.auth }, env.SESSION_SECRET, env.SESSION_TTL_SECONDS), cookieOptions());
}
