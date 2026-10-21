import { describe, it, expect } from "vitest";
import { createSecretBox, generateRecoveryCodes, normalizeRecoveryCode, parseMasterKey } from "./secret-box.js";
import { issueMfaToken, verifyMfaToken } from "./mfa-token.js";
import { issueSession, verifySession } from "./session.js";

const KEY = Buffer.alloc(32, 9).toString("base64");

describe("secret box (AES-256-GCM at rest)", () => {
  it("round-trips, uses a fresh IV each time and never stores the plaintext", () => {
    const box = createSecretBox(KEY);
    const secret = Buffer.from("12345678901234567890");
    const a = box.encrypt(secret, "u1"), b = box.encrypt(secret, "u1");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/);
    expect(a).not.toContain(secret.toString("base64url"));
    expect(box.decrypt(a, "u1").equals(secret)).toBe(true);
  });

  it("fails closed on another user's row, a tampered value, a wrong key or an unknown format", () => {
    const box = createSecretBox(KEY);
    const c = box.encrypt(Buffer.from("s3cret-seed-bytes!!!"), "u1");
    expect(() => box.decrypt(c, "u2")).toThrow();
    const parts = c.split(".");
    const flipped = Buffer.from(parts[3]!, "base64url"); flipped[0]! ^= 1;
    expect(() => box.decrypt([parts[0], parts[1], parts[2], flipped.toString("base64url")].join("."), "u1")).toThrow();
    expect(() => createSecretBox(Buffer.alloc(32, 1).toString("base64")).decrypt(c, "u1")).toThrow();
    expect(() => box.decrypt("JBSWY3DPEHPK3PXP", "u1")).toThrow("unsupported ciphertext"); // a legacy plaintext value is never used
  });

  it("requires a 32-byte base64 master key", () => {
    expect(() => parseMasterKey(Buffer.alloc(16).toString("base64"))).toThrow("32 bytes");
    expect(() => parseMasterKey("not base64 at all!!")).toThrow();
    expect(parseMasterKey(KEY).length).toBe(32);
  });

  it("generates 10 distinct high-entropy recovery codes and hashes them per user, keyed", () => {
    const box = createSecretBox(KEY);
    const codes = generateRecoveryCodes();
    expect(codes.length).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    const h = box.hashRecoveryCode(codes[0]!, "u1");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(box.hashRecoveryCode(codes[0]!.toLowerCase().replace("-", " "), "u1")).toBe(h); // normalized input
    expect(box.hashRecoveryCode(codes[0]!, "u2")).not.toBe(h);
    expect(createSecretBox(Buffer.alloc(32, 1).toString("base64")).hashRecoveryCode(codes[0]!, "u1")).not.toBe(h);
    expect(normalizeRecoveryCode(" abcde-fghij ")).toBe("ABCDEFGHIJ");
  });
});

describe("pending MFA token", () => {
  const secret = "s".repeat(40);
  it("verifies within 5 minutes and expires after", () => {
    const t = issueMfaToken("u1", 3, secret, 1_000_000_000);
    expect(verifyMfaToken(t, secret, 1_000_000_000 + 299_000)).toMatchObject({ uid: "u1", sv: 3 });
    expect(verifyMfaToken(t, secret, 1_000_000_000 + 300_000)).toBeNull();
    expect(verifyMfaToken(t, "x".repeat(40), 1_000_000_000)).toBeNull();
  });
  it("is never accepted as a session token, and a session token is never accepted as an MFA token", () => {
    const mfa = issueMfaToken("u1", 0, secret);
    expect(verifySession(mfa, secret)).toBeNull();
    const session = issueSession({ uid: "u1", role: "owner", tid: "t", sv: 0 }, secret, 1800);
    expect(verifyMfaToken(session, secret)).toBeNull();
  });
});
