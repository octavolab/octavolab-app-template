/**
 * Boot-time strength checks for secrets that live as plaintext Lightsail environment variables (docs/secrets.md).
 * Pure functions: they return a reason (never the value) or null. The env schema applies them in production, so a
 * weak, placeholder or truncated secret stops the process at boot instead of silently protecting sessions with it.
 *
 * Thresholds are deliberately conservative: anything generated as documented (`openssl rand -base64 48`,
 * `openssl rand -hex 32`) passes with a wide margin; typed passwords, repeated characters and template placeholders fail.
 */

/** Shannon entropy of the character distribution, in bits per character. */
export function shannonBitsPerChar(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...s].length;
  let bits = 0;
  for (const c of counts.values()) { const p = c / n; bits -= p * Math.log2(p); }
  return bits;
}

/** Fragments that only appear in placeholders and examples (.env.example, docs, tests). Compared case-insensitively. */
const PLACEHOLDERS = ["change-me", "changeme", "replace-me", "example", "placeholder", "your-secret", "ci-only", "not-a-secret", "password", "xxxx"];

/** True when the string is a shorter unit repeated (e.g. "abcabcabc", the hex alphabet twice): not random whatever its entropy. */
export function isRepeatedPattern(s: string): boolean {
  for (let period = 1; period <= s.length / 2; period++) {
    if (s.length % period === 0 && s.slice(0, period).repeat(s.length / period) === s) return true;
  }
  return false;
}

export const SESSION_SECRET_MIN_LENGTH = 32;
/**
 * Entropy floor per character AND in total (bits/char x length). Measured on the string itself, so random hex (~3.8 of a
 * possible 4.0 over 64 characters) and base64 (~5.4) pass with margin; long runs of a few characters fail.
 */
export const SESSION_SECRET_MIN_BITS_PER_CHAR = 3.0;
export const SESSION_SECRET_MIN_TOTAL_BITS = 128;
// 10, not 16: 64 hex characters (`openssl rand -hex 32`) miss at least one of the 16 hex digits about 23 % of the time.
export const SESSION_SECRET_MIN_DISTINCT = 10;

export function weakSessionSecretReason(secret: string): string | null {
  if (secret.length < SESSION_SECRET_MIN_LENGTH) return `must be at least ${SESSION_SECRET_MIN_LENGTH} characters`;
  const lower = secret.toLowerCase();
  if (PLACEHOLDERS.some((p) => lower.includes(p))) return "looks like a placeholder; generate it with `openssl rand -base64 48`";
  if (isRepeatedPattern(secret)) return "is a repeated pattern; generate it with `openssl rand -base64 48`";
  if (new Set(secret).size < SESSION_SECRET_MIN_DISTINCT) return `too few distinct characters (need ${SESSION_SECRET_MIN_DISTINCT}); generate it with \`openssl rand -base64 48\``;
  const bits = shannonBitsPerChar(secret);
  if (bits < SESSION_SECRET_MIN_BITS_PER_CHAR || bits * secret.length < SESSION_SECRET_MIN_TOTAL_BITS) return "entropy too low; generate it with `openssl rand -base64 48`";
  return null;
}

/** TOTP_ENC_KEY is already checked to be exactly 32 bytes of base64; this rejects keys that are not random (e.g. all zeros). */
export function weakMasterKeyReason(key: Buffer): string | null {
  if (key.length !== 32) return "must be 32 bytes";
  if (new Set(key).size < 16) return "is not random (too few distinct bytes); generate it with `openssl rand -base64 32`";
  return null;
}

export const DATABASE_PASSWORD_MIN_LENGTH = 16;

/** The connection string must carry a real password (Lightsail generates long ones) and must not be a local/dev URL. */
export function weakDatabaseUrlReason(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "is not a valid URL"; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return "must be a postgresql:// URL";
  const password = decodeURIComponent(u.password);
  if (password.length < DATABASE_PASSWORD_MIN_LENGTH) return `must include a password of at least ${DATABASE_PASSWORD_MIN_LENGTH} characters`;
  const lower = password.toLowerCase();
  if (PLACEHOLDERS.some((p) => lower.includes(p)) || new Set(password).size < 8) return "has a placeholder or low-entropy password";
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) return "points at localhost; production must use the managed database";
  return null;
}
