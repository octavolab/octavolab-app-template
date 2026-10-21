import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { issueSession, verifySession, needsRotation } from "./session.js";

const secret = "x".repeat(32);
const base = { uid: "u1", role: "admin" as const, tid: "t1" };

describe("session", () => {
  it("round-trips a valid session", () => {
    const t = issueSession(base, secret, 1800);
    expect(verifySession(t, secret)?.uid).toBe("u1");
  });
  it("rejects a tampered payload", () => {
    const [p, m] = issueSession(base, secret, 1800).split(".");
    const forged = Buffer.from(JSON.stringify({ ...base, role: "owner", exp: 9_999_999_999 })).toString("base64url");
    expect(verifySession(`${forged}.${m}`, secret)).toBeNull();
    expect(verifySession(`${p}.${m}x`, secret)).toBeNull();
  });
  it("rejects a token signed with another secret", () => {
    expect(verifySession(issueSession(base, "y".repeat(32), 1800), secret)).toBeNull();
  });
  it("expires", () => {
    const t = issueSession(base, secret, 60, 0);
    expect(verifySession(t, secret, 61_000)).toBeNull();
  });
  it("asks for rotation after half its life", () => {
    const s = verifySession(issueSession(base, secret, 1800, 0), secret, 0)!;
    expect(needsRotation(s, 1800, 1_000_000)).toBe(true);
    expect(needsRotation(s, 1800, 0)).toBe(false);
  });
  it("rejects a correctly signed payload that is not valid JSON", () => {
    const payload = Buffer.from("not json").toString("base64url");
    const mac = createHmac("sha256", secret).update(payload).digest("base64url");
    expect(verifySession(`${payload}.${mac}`, secret)).toBeNull();
  });
  it("ends after the absolute lifetime even if rotated", () => {
    const t0 = 0;
    const first = verifySession(issueSession(base, secret, 1800, t0), secret, t0)!;
    const rotated = issueSession({ ...base, auth: first.auth }, secret, 1800, (12 * 3600 - 60) * 1000);
    expect(verifySession(rotated, secret, (12 * 3600 - 30) * 1000)).not.toBeNull();
    expect(verifySession(rotated, secret, 12 * 3600 * 1000)).toBeNull();
  });
  it("rejects garbage", () => {
    expect(verifySession(undefined, secret)).toBeNull();
    expect(verifySession("abc", secret)).toBeNull();
  });
});
