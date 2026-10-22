import { prisma } from "@octavolab/db";
import argon2 from "argon2";
import { env } from "../config/env.js";
import { usersRepo, recoveryCodesRepo } from "../repositories/users.repository.js";
import { auditRepo } from "../repositories/audit.repository.js";
import { createSecretBox, generateRecoveryCodes, type SecretBox } from "../lib/secret-box.js";
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from "../lib/totp.js";
import { AppError, conflict, notFound } from "../lib/errors.js";
import type { Session } from "../lib/session.js";

/**
 * TOTP two-factor authentication (RFC 6238) for staff and owner roles (ASVS V2.8 / 6.x single-factor OTP verifiers).
 * Business rules live here; routes only parse input, rate-limit and set cookies.
 *  - Enrollment: the secret is generated server-side, stored encrypted (AES-256-GCM, TOTP_ENC_KEY), and the otpauth URI is
 *    returned once. 2FA is enabled only after a valid code proves the authenticator has the secret.
 *  - Activation issues 10 single-use recovery codes (stored as keyed HMAC-SHA256) and revokes the user's other sessions.
 *  - Codes are single-use (last accepted step stored, atomically advanced), checked with +/- 1 step of drift.
 *  - Every change is audited; failures are audited and logged without codes or secrets.
 */
export const MFA_ROLES: readonly Session["role"][] = ["owner", "admin", "operations"];
export const RECOVERY_CODE_COUNT = 10;

type UserRow = NonNullable<Awaited<ReturnType<typeof usersRepo.byId>>>;
type Factor = { code?: string | undefined; recoveryCode?: string | undefined };
type Meta = { ip: string; requestId: string };

let cached: { key: string; box: SecretBox } | undefined;
/** The secret box for the configured key; 503 when 2FA is not configured (never a silent bypass). */
export function secretBox(): SecretBox {
  const key = env.TOTP_ENC_KEY;
  if (!key) throw new AppError("MFA_NOT_CONFIGURED", "Two-factor authentication is not configured on this server", 503);
  if (cached?.key !== key) cached = { key, box: createSecretBox(key) };
  return cached.box;
}

export const mfaEnabled = (u: Pick<UserRow, "totpEnabledAt">) => Boolean(u.totpEnabledAt);

/** Privileged roles (owner and admin: they change prices, roles and orders) must enroll before using the app when REQUIRE_PRIVILEGED_2FA=true. */
export const PRIVILEGED_MFA_ROLES: readonly Session["role"][] = ["owner", "admin"];
export const enrollmentRequired = (u: Pick<UserRow, "role" | "totpEnabledAt">) => PRIVILEGED_MFA_ROLES.includes(u.role) && env.REQUIRE_PRIVILEGED_2FA && !mfaEnabled(u);

function assertMfaRole(u: Pick<UserRow, "role">) {
  if (!MFA_ROLES.includes(u.role)) throw new AppError("MFA_NOT_AVAILABLE", "Two-factor authentication is available for staff and owner accounts", 403);
}

async function loadUser(userId: string) {
  const u = await usersRepo.byId(userId);
  if (!u) throw notFound("User");
  return u;
}

/** Starts (or restarts) enrollment. Returns the secret ONCE; it is never readable again through the API. */
export async function startEnrollment(userId: string, meta: Meta) {
  const box = secretBox();
  const u = await loadUser(userId);
  assertMfaRole(u);
  if (mfaEnabled(u)) throw conflict("Two-factor authentication is already enabled; disable it first");
  const secret = generateTotpSecret();
  if (!(await usersRepo.setPendingTotp(u.id, box.encrypt(secret, u.id)))) throw conflict("Two-factor authentication is already enabled; disable it first");
  await auditRepo.record({ entity: "User", entityId: u.id, action: "mfa_enroll_started", actor: `user:${u.id}`, after: { ...meta } });
  return { otpauthUri: otpauthUri(secret, u.email, env.TOTP_ISSUER), secret: base32Encode(secret), issuer: env.TOTP_ISSUER, algorithm: "SHA1", digits: 6, periodSeconds: 30 };
}

/** Pending -> enabled with a valid code; returns the 10 recovery codes (shown once) and the new session version. */
export async function activate(userId: string, code: string, meta: Meta, now = new Date()) {
  const box = secretBox();
  const u = await loadUser(userId);
  assertMfaRole(u);
  if (mfaEnabled(u) || !u.totpSecret) throw new AppError("MFA_NOT_PENDING", "Start enrollment first", 409);
  const step = verifyTotp(box.decrypt(u.totpSecret, u.id), code, now.getTime());
  if (step === null) {
    await recordFailure(u.id, "activate", "invalid_code", meta);
    throw new AppError("MFA_INVALID_CODE", "The code is not valid", 422);
  }
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  await prisma.$transaction(async (tx) => {
    if (!(await usersRepo.activateTotp(tx, u.id, step, now))) throw conflict("Enrollment changed; start again");
    await recoveryCodesRepo.replace(tx, u.id, codes.map((c) => box.hashRecoveryCode(c, u.id)));
    await auditRepo.record({ entity: "User", entityId: u.id, action: "mfa_enabled", actor: `user:${u.id}`, after: { ...meta, recoveryCodes: RECOVERY_CODE_COUNT } }, tx);
  });
  return { recoveryCodes: codes, sessionVersion: u.sessionVersion + 1 };
}

/**
 * Checks a second factor for a user with 2FA enabled: a TOTP code (single-use per step) or an unused recovery code
 * (consumed). Returns the method used, or null. Never says which part failed.
 */
export async function verifySecondFactor(u: UserRow, f: Factor, now = new Date()): Promise<"totp" | "recovery_code" | null> {
  const box = secretBox();
  if (!mfaEnabled(u) || !u.totpSecret) return null;
  if (f.code) {
    const step = verifyTotp(box.decrypt(u.totpSecret, u.id), f.code, now.getTime());
    return step !== null && (await usersRepo.consumeTotpStep(u.id, step)) ? "totp" : null;
  }
  if (f.recoveryCode) return (await recoveryCodesRepo.use(u.id, box.hashRecoveryCode(f.recoveryCode, u.id), now)) ? "recovery_code" : null;
  return null;
}

export async function recordFailure(userId: string, stage: "login" | "activate" | "disable" | "regenerate", reason: string, meta: Meta) {
  await auditRepo.record({ entity: "User", entityId: userId, action: "mfa_failed", actor: `user:${userId}`, after: { stage, reason, ...meta } });
}

/** Disable needs the password AND a second factor; owners and admins cannot disable it while REQUIRE_PRIVILEGED_2FA=true. */
export async function disable(userId: string, password: string, f: Factor, meta: Meta) {
  secretBox();
  const u = await loadUser(userId);
  if (!mfaEnabled(u)) throw new AppError("MFA_NOT_ENABLED", "Two-factor authentication is not enabled", 409);
  if (PRIVILEGED_MFA_ROLES.includes(u.role) && env.REQUIRE_PRIVILEGED_2FA) throw new AppError("MFA_REQUIRED", "Owners and admins must keep two-factor authentication enabled", 409);
  const passwordOk = await argon2.verify(u.passwordHash, password).catch(() => false);
  const method = passwordOk ? await verifySecondFactor(u, f) : null;
  if (!method) {
    await recordFailure(u.id, "disable", passwordOk ? "invalid_code" : "bad_password", meta);
    throw new AppError("MFA_INVALID_CODE", "Password or code is not valid", 422);
  }
  await prisma.$transaction(async (tx) => {
    await usersRepo.clearTotp(tx, u.id);
    await recoveryCodesRepo.deleteAll(tx, u.id);
    await auditRepo.record({ entity: "User", entityId: u.id, action: "mfa_disabled", actor: `user:${u.id}`, after: { ...meta, method } }, tx);
  });
  return { sessionVersion: u.sessionVersion + 1 };
}

/** New set of 10 recovery codes (the old ones stop working), confirmed with a current TOTP code. */
export async function regenerateRecoveryCodes(userId: string, code: string, meta: Meta) {
  const box = secretBox();
  const u = await loadUser(userId);
  if (!mfaEnabled(u)) throw new AppError("MFA_NOT_ENABLED", "Two-factor authentication is not enabled", 409);
  if ((await verifySecondFactor(u, { code })) !== "totp") {
    await recordFailure(u.id, "regenerate", "invalid_code", meta);
    throw new AppError("MFA_INVALID_CODE", "The code is not valid", 422);
  }
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  await prisma.$transaction(async (tx) => {
    await recoveryCodesRepo.replace(tx, u.id, codes.map((c) => box.hashRecoveryCode(c, u.id)));
    await auditRepo.record({ entity: "User", entityId: u.id, action: "mfa_recovery_codes_regenerated", actor: `user:${u.id}`, after: { ...meta } }, tx);
  });
  return { recoveryCodes: codes };
}

/**
 * Owner resets another user's 2FA in the owner's tenant (lost device and lost recovery codes). Never on oneself: a locked-out
 * owner follows the runbook (docs/runbook.md) with Jaime's approval. Revokes the target's sessions.
 */
export async function resetForUser(targetId: string, ctx: { tenantId: string; actorId: string } & Meta) {
  if (targetId === ctx.actorId) throw new AppError("SELF_MFA_RESET", "Owners cannot reset their own two-factor authentication", 409);
  const u = await usersRepo.byId(targetId);
  if (!u || u.tenantId !== ctx.tenantId) throw notFound("User");
  // An owner's second factor is never removed by another owner from the API: it follows the runbook (identity check out of band).
  if (u.role === "owner") throw new AppError("OWNER_MFA_RESET", "Owner 2FA reset follows the runbook", 409);
  await prisma.$transaction(async (tx) => {
    await usersRepo.clearTotp(tx, u.id);
    await recoveryCodesRepo.deleteAll(tx, u.id);
    await auditRepo.record({ entity: "User", entityId: u.id, action: "mfa_reset", actor: `user:${ctx.actorId}`, before: { mfaEnabled: mfaEnabled(u) }, after: { mfaEnabled: false, ip: ctx.ip, requestId: ctx.requestId } }, tx);
  });
  return { id: u.id, mfaEnabled: false };
}
