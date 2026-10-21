import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226), implemented with node:crypto only (no dependency). Tested against the
 * RFC 6238 Appendix B vectors for SHA-1, SHA-256 and SHA-512 (lib/totp.test.ts).
 * Defaults match every common authenticator app: SHA-1, 6 digits, 30-second steps.
 */
export type TotpAlgorithm = "sha1" | "sha256" | "sha512";
export const TOTP_DEFAULTS = { digits: 6, periodSeconds: 30, algorithm: "sha1" as TotpAlgorithm };

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding (the form authenticator apps expect in otpauth URIs). */
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerant decoder: case-insensitive, ignores spaces, hyphens and "=" padding; throws on any other character. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** HOTP value for one counter (RFC 4226 section 5.3: dynamic truncation, 64-bit big-endian counter). */
export function hotp(key: Buffer, counter: number, digits = TOTP_DEFAULTS.digits, algorithm: TotpAlgorithm = TOTP_DEFAULTS.algorithm): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("invalid counter");
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algorithm, key).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Time step for a Unix time in milliseconds (T = floor((now - T0) / X), T0 = 0). */
export const timeStep = (nowMs: number, periodSeconds = TOTP_DEFAULTS.periodSeconds) => Math.floor(nowMs / 1000 / periodSeconds);

export function totp(key: Buffer, nowMs: number, opts: Partial<typeof TOTP_DEFAULTS> = {}): string {
  const o = { ...TOTP_DEFAULTS, ...opts };
  return hotp(key, timeStep(nowMs, o.periodSeconds), o.digits, o.algorithm);
}

/**
 * Checks a code against the current step and `window` steps either side (clock drift), comparing in constant time and
 * always computing every candidate. Returns the matched step (callers store it and refuse any step <= the last one used,
 * which makes each code single-use) or null.
 */
export function verifyTotp(key: Buffer, code: string, nowMs: number, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = timeStep(nowMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let step = now - window; step <= now + window; step++) {
    if (step < 0) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, step)), given) && matched === null) matched = step;
  }
  return matched;
}

/** 160-bit secret (RFC 4226 recommends at least 128 bits; 160 is the HMAC-SHA1 block-friendly size apps expect). */
export const generateTotpSecret = () => randomBytes(20);

export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: "SHA1", digits: String(TOTP_DEFAULTS.digits), period: String(TOTP_DEFAULTS.periodSeconds) });
  return `otpauth://totp/${label}?${q.toString()}`;
}
