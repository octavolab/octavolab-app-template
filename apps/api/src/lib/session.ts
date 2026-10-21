import { createHmac, timingSafeEqual } from "node:crypto";

/** Stateless signed session (HMAC-SHA256). Short-lived; rotated on every authenticated request that is past half its life. */
export type Session = { uid: string; role: "owner" | "admin" | "operations" | "customer"; tid: string | null; exp: number; auth: number };

/** Absolute lifetime: a session rotated forever still ends this long after the original sign-in. */
export const MAX_SESSION_AGE_SECONDS = 12 * 60 * 60;

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest("base64url");

export function issueSession(s: Omit<Session, "exp" | "auth"> & { auth?: number }, secret: string, ttlSeconds: number, now = Date.now()): string {
  const nowS = Math.floor(now / 1000);
  const auth = s.auth ?? nowS;
  const exp = Math.min(nowS + ttlSeconds, auth + MAX_SESSION_AGE_SECONDS);
  const payload = b64(JSON.stringify({ ...s, auth, exp }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string | undefined, secret: string, now = Date.now()): Session | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload, secret);
  if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    const nowS = Math.floor(now / 1000);
    if (typeof s.exp !== "number" || s.exp <= nowS) return null;
    if (typeof s.auth !== "number" || nowS - s.auth >= MAX_SESSION_AGE_SECONDS) return null;
    return s;
  } catch {
    return null;
  }
}

export function needsRotation(s: Session, ttlSeconds: number, now = Date.now()): boolean {
  return s.exp - Math.floor(now / 1000) < ttlSeconds / 2;
}
