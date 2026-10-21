import { createHmac, timingSafeEqual } from "node:crypto";

/** Stateless signed session (HMAC-SHA256). Short-lived; rotated on every authenticated request that is past half its life. */
export type Session = { uid: string; role: "owner" | "admin" | "operations" | "customer"; tid: string | null; exp: number };

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest("base64url");

export function issueSession(s: Omit<Session, "exp">, secret: string, ttlSeconds: number, now = Date.now()): string {
  const payload = b64(JSON.stringify({ ...s, exp: Math.floor(now / 1000) + ttlSeconds }));
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
    if (typeof s.exp !== "number" || s.exp <= Math.floor(now / 1000)) return null;
    return s;
  } catch {
    return null;
  }
}

export function needsRotation(s: Session, ttlSeconds: number, now = Date.now()): boolean {
  return s.exp - Math.floor(now / 1000) < ttlSeconds / 2;
}
