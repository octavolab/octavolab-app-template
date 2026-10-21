import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption at rest for TOTP secrets (ASVS 6.2: approved authenticated encryption; key outside the database).
 * Master key: TOTP_ENC_KEY, 32 random bytes in base64 (`openssl rand -base64 32`). Two sub-keys are derived with HKDF-SHA256
 * so one key never serves two purposes: AES-256-GCM for secrets, HMAC-SHA256 for recovery-code hashes.
 *
 * Ciphertext format: `v1.<iv>.<tag>.<ciphertext>` (base64url; 96-bit random IV, 128-bit tag). The associated data binds the
 * ciphertext to its user (`user:<id>`), so a secret copied onto another user's row does not decrypt.
 */
export function parseMasterKey(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== b64.trim().replace(/=+$/, "")) throw new Error("TOTP_ENC_KEY must be 32 bytes in base64");
  return key;
}

const derive = (master: Buffer, info: string) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32));

export function createSecretBox(masterB64: string) {
  const master = parseMasterKey(masterB64);
  const encKey = derive(master, "octavolab/totp-secret/aes-256-gcm/v1");
  const macKey = derive(master, "octavolab/recovery-code/hmac-sha256/v1");
  return {
    encrypt(plaintext: Buffer, userId: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", encKey, iv);
      c.setAAD(Buffer.from(`user:${userId}`));
      const ct = Buffer.concat([c.update(plaintext), c.final()]);
      return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
    },
    /** Throws on a wrong key, a tampered value, another user's ciphertext or an unknown format (fail closed). */
    decrypt(value: string, userId: string): Buffer {
      const [v, iv, tag, ct] = value.split(".");
      if (v !== "v1" || !iv || !tag || !ct) throw new Error("unsupported ciphertext");
      const d = createDecipheriv("aes-256-gcm", encKey, Buffer.from(iv, "base64url"));
      d.setAAD(Buffer.from(`user:${userId}`));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
    },
    /** Keyed hash of a normalized recovery code: a leaked database alone cannot be brute-forced offline. */
    hashRecoveryCode(code: string, userId: string): string {
      return createHmac("sha256", macKey).update(`${userId}:${normalizeRecoveryCode(code)}`).digest("hex");
    },
  };
}
export type SecretBox = ReturnType<typeof createSecretBox>;

const RC_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no 0/O, 1/I: 10 symbols = 50 bits

/** Ten single-use recovery codes, `XXXXX-XXXXX`, 50 bits of entropy each (rejection-free: 256 % 32 === 0). */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const s = [...randomBytes(10)].map((b) => RC_ALPHABET[b % 32]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");
