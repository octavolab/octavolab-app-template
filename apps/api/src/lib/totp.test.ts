import { describe, it, expect } from "vitest";
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp, generateTotpSecret, timeStep } from "./totp.js";

// RFC 6238 Appendix B: seeds are the ASCII string "12345678901234567890" repeated to the hash's key length.
const SEED = { sha1: Buffer.from("12345678901234567890"), sha256: Buffer.from("12345678901234567890123456789012"), sha512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234") };
const VECTORS: [number, string, string, string][] = [
  // [unix seconds, SHA1, SHA256, SHA512], 8 digits
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("TOTP (RFC 6238)", () => {
  it.each(VECTORS)("matches the RFC 6238 Appendix B vectors at T=%i", (t, sha1, sha256, sha512) => {
    expect(totp(SEED.sha1, t * 1000, { digits: 8, algorithm: "sha1" })).toBe(sha1);
    expect(totp(SEED.sha256, t * 1000, { digits: 8, algorithm: "sha256" })).toBe(sha256);
    expect(totp(SEED.sha512, t * 1000, { digits: 8, algorithm: "sha512" })).toBe(sha512);
  });

  it("matches the RFC 4226 Appendix D HOTP values (6 digits)", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expect(expected.map((_, c) => hotp(SEED.sha1, c))).toEqual(expected);
  });

  it("accepts the current step and one step of drift either side, returns the matched step, rejects the rest", () => {
    const key = generateTotpSecret();
    const now = 1_790_000_015_000;
    const step = timeStep(now);
    expect(verifyTotp(key, hotp(key, step), now)).toBe(step);
    expect(verifyTotp(key, hotp(key, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(key, hotp(key, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(key, hotp(key, step - 2), now)).toBeNull();
    expect(verifyTotp(key, hotp(key, step + 2), now)).toBeNull();
    for (const bad of ["", "12345", "1234567", "abcdef", " 123456", "12345\n"]) expect(verifyTotp(key, bad, now)).toBeNull();
  });

  it("round-trips base32 (RFC 4648 test vectors) and builds a standard otpauth URI", () => {
    const pairs: [string, string][] = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
    for (const [plain, enc] of pairs) {
      expect(base32Encode(Buffer.from(plain))).toBe(enc);
      expect(base32Decode(enc.toLowerCase()).toString()).toBe(plain);
    }
    expect(() => base32Decode("MZ1W")).toThrow("invalid base32");
    const uri = new URL(otpauthUri(SEED.sha1, "ana@a.co", "OctavoLab Test"));
    expect(uri.protocol).toBe("otpauth:");
    expect([uri.host, decodeURIComponent(uri.pathname)]).toEqual(["totp", "/OctavoLab Test:ana@a.co"]);
    expect(Object.fromEntries(uri.searchParams)).toEqual({ secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", issuer: "OctavoLab Test", algorithm: "SHA1", digits: "6", period: "30" });
  });
});
