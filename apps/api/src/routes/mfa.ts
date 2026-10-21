import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth, reissueSession, tenantOf } from "../lib/auth.js";
import type { MfaLimiter } from "../lib/login-limiter.js";
import { AppError } from "../lib/errors.js";
import { activate, disable, regenerateRecoveryCodes, resetForUser, startEnrollment } from "../services/mfa.service.js";

/** Exactly one second factor: a 6-digit TOTP code or a recovery code. */
export const SecondFactor = z.object({
  code: z.string().regex(/^\d{6}$/, "6 digits").optional(),
  recoveryCode: z.string().min(10).max(24).regex(/^[A-Za-z0-9 -]+$/).optional(),
}).strict().refine((b) => Boolean(b.code) !== Boolean(b.recoveryCode), { message: "send exactly one of code or recoveryCode" });

const STAFF = ["owner", "admin", "operations"] as const;
const Code = z.object({ code: z.string().regex(/^\d{6}$/, "6 digits") }).strict();
/** Secrets and recovery codes are shown once: no browser, proxy or CDN may keep a copy. */
const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store").header("pragma", "no-cache");

/**
 * 2FA management for staff and owner (customers get 403). Registered from authRoutes so it shares the MFA limiter with
 * the login step: every code check (login, activate, disable, regenerate) counts against the same per-user budget.
 */
export async function registerMfaRoutes(app: FastifyInstance, limiter: MfaLimiter) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const staffEnroll = requireAuth([...STAFF], { allowMfaEnrollment: true });
  const meta = (req: { ip: string; id: string }) => ({ ip: req.ip, requestId: req.id });
  const limited = async (req: { user?: { uid: string }; ip: string }) => { await limiter.check(req.user!.uid, req.ip); };
  /** Counts a rejected code toward the user's daily failure cap, then rethrows. */
  const counted = async <T>(uid: string, fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) {
      if (e instanceof AppError && e.code === "MFA_INVALID_CODE") await limiter.fail(uid);
      throw e;
    }
  };

  r.post("/auth/2fa/enroll", {
    preHandler: staffEnroll,
    schema: { tags: ["auth", "2fa"], summary: "Start TOTP enrollment: returns the otpauth URI and secret once", description: "Staff and owner only. Restarting before activation replaces the pending secret. 409 if 2FA is already enabled. Response is Cache-Control: no-store." },
  }, async (req, reply) => { noStore(reply); return startEnrollment(req.user!.uid, meta(req)); });

  r.post("/auth/2fa/activate", {
    preHandler: [staffEnroll, limited],
    schema: { tags: ["auth", "2fa"], summary: "Activate TOTP with a code from the authenticator; returns 10 single-use recovery codes once", description: "Revokes the user's other sessions and re-issues the caller's cookie. 422 MFA_INVALID_CODE on a wrong code (rate-limited, audited).", body: Code },
  }, async (req, reply) => {
    const res = await counted(req.user!.uid, () => activate(req.user!.uid, req.body.code, meta(req)));
    reissueSession(reply, req.user!, res.sessionVersion);
    noStore(reply);
    return { mfaEnabled: true, recoveryCodes: res.recoveryCodes };
  });

  r.post("/auth/2fa/disable", {
    preHandler: [requireAuth([...STAFF]), limited],
    schema: { tags: ["auth", "2fa"], summary: "Disable 2FA with the password and a code or recovery code", description: "409 MFA_REQUIRED for owners while REQUIRE_OWNER_2FA=true. Revokes the user's other sessions.", body: z.object({ password: z.string().min(8).max(200) }).merge(SecondFactor.innerType()).strict().refine((b) => Boolean(b.code) !== Boolean(b.recoveryCode), { message: "send exactly one of code or recoveryCode" }) },
  }, async (req, reply) => {
    const res = await counted(req.user!.uid, () => disable(req.user!.uid, req.body.password, req.body, meta(req)));
    reissueSession(reply, req.user!, res.sessionVersion);
    return { mfaEnabled: false };
  });

  r.post("/auth/2fa/recovery-codes", {
    preHandler: [requireAuth([...STAFF]), limited],
    schema: { tags: ["auth", "2fa"], summary: "Replace the recovery codes (old ones stop working); confirm with a TOTP code", body: Code },
  }, async (req, reply) => { noStore(reply); return counted(req.user!.uid, () => regenerateRecoveryCodes(req.user!.uid, req.body.code, meta(req))); });

  r.post("/users/:id/2fa/reset", {
    preHandler: requireAuth(["owner"]),
    schema: { tags: ["users", "2fa"], summary: "Owner: reset another user's 2FA in the owner's tenant (lost device); audited, revokes their sessions", params: z.object({ id: z.string().min(1).max(64) }) },
  }, async (req) => resetForUser(req.params.id, { tenantId: tenantOf(req), actorId: req.user!.uid, ...meta(req) }));
}
