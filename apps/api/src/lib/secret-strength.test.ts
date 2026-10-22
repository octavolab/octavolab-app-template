import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { shannonBitsPerChar, isRepeatedPattern, weakSessionSecretReason, weakMasterKeyReason, weakDatabaseUrlReason } from "./secret-strength.js";

describe("secret strength", () => {
  it("shannonBitsPerChar", () => {
    expect(shannonBitsPerChar("")).toBe(0);
    expect(shannonBitsPerChar("aaaa")).toBe(0);
    expect(shannonBitsPerChar("abab")).toBe(1);
    expect(shannonBitsPerChar("0123456789abcdef")).toBe(4);
  });
  it("isRepeatedPattern", () => {
    expect([isRepeatedPattern("aaaa"), isRepeatedPattern("abcabc"), isRepeatedPattern("abcab"), isRepeatedPattern("a")]).toEqual([true, true, false, false]);
  });
  it("accepts generated secrets of every documented shape", () => {
    for (let i = 0; i < 2000; i++) {
      expect(weakSessionSecretReason(randomBytes(48).toString("base64"))).toBeNull();
      expect(weakSessionSecretReason(randomBytes(32).toString("hex"))).toBeNull();
      expect(weakMasterKeyReason(randomBytes(32))).toBeNull();
    }
  });
  it("rejects short, placeholder, repetitive and low-entropy session secrets", () => {
    expect(weakSessionSecretReason("short")).toMatch(/at least 32/);
    expect(weakSessionSecretReason("Change-Me-please-0123456789abcdefghij")).toMatch(/placeholder/);
    expect(weakSessionSecretReason("abcdefghijklmnopqrstuvwxyz012345abcdefghijklmnopqrstuvwxyz012345")).toMatch(/repeated pattern/);
    expect(weakSessionSecretReason("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab")).toMatch(/distinct/);
    expect(weakSessionSecretReason("abcdefghiabcdefghiabcdefghiabcdefghiaa")).toMatch(/distinct/);
    expect(weakSessionSecretReason("abcdefghijklmnopaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toMatch(/entropy/);
    expect(weakSessionSecretReason("abcdefghijk0123456789ab")).toMatch(/at least 32/);

  });
  it("master key: 32 random bytes", () => {
    expect(weakMasterKeyReason(Buffer.alloc(16))).toMatch(/32 bytes/);
    expect(weakMasterKeyReason(Buffer.alloc(32))).toMatch(/not random/);
  });
  it("database URL", () => {
    const pw = randomBytes(20).toString("hex");
    expect(weakDatabaseUrlReason(`postgresql://app:${pw}@db.example:5432/app?sslmode=require`)).toBeNull();
    expect(weakDatabaseUrlReason(`postgres://app:${pw}@db.example/app`)).toBeNull();
    expect(weakDatabaseUrlReason("not a url")).toMatch(/valid URL/);
    expect(weakDatabaseUrlReason(`mysql://app:${pw}@db.example/app`)).toMatch(/postgresql/);
    expect(weakDatabaseUrlReason("postgresql://app@db.example/app")).toMatch(/password/);
    expect(weakDatabaseUrlReason("postgresql://app:aaaaaaaaaaaaaaaaaaaa@db.example/app")).toMatch(/low-entropy/);
    expect(weakDatabaseUrlReason(`postgresql://app:${pw}@127.0.0.1/app`)).toMatch(/localhost/);
  });
});
