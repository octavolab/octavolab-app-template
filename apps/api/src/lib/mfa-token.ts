import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Short-lived token for the second login step, sent as the httpOnly `mfa` cookie after a correct password.
 * Signed with a key derived from SESSION_SECRET for this purpose only, so it can never be accepted as a session token
 * (and a session token is never accepted here). Bound to the user's sessionVersion: logout, a role change or a 2FA
 * change in between invalidates it.
 */
export const MFA_COOKIE = "mfa";
export const MFA_TOKEN_TTL_SECONDS = 300;
export type MfaPending = { uid: string; sv: number; exp: number; n: string };

const keyOf = (secret: string) => createHmac("sha256", secret).update("octavolab/mfa-pending/v1").digest();

export function issueMfaToken(uid: string, sv: number, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ uid, sv, exp: Math.floor(now / 1000) + MFA_TOKEN_TTL_SECONDS, n: randomBytes(8).toString("hex") })).toString("base64url");
  return `${payload}.${createHmac("sha256", keyOf(secret)).update(payload).digest("base64url")}`;
}

export function verifyMfaToken(token: string | undefined, secret: string, now = Date.now()): MfaPending | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", keyOf(secret)).update(payload).digest("base64url");
  if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, "base64url").toString()) as MfaPending;
    if (typeof t.uid !== "string" || typeof t.sv !== "number" || typeof t.exp !== "number") return null;
    return t.exp > Math.floor(now / 1000) ? t : null;
  } catch {
    return null;
  }
}
