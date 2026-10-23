import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "http://localhost:5173", OPS_EMAIL: "ops@test.invalid" });
const { parseEnv, readBuildVersion, integrationKeyIssues } = await import("./env.js");

const base = { DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "https://app.example.com", OPS_EMAIL: "ops@test.invalid" };

// Production fixtures are generated at runtime (random, never committed), like the real secrets must be.
const strong = () => ({
  DATABASE_URL: `postgresql://app:${randomBytes(24).toString("hex")}@db.internal.example:5432/app`,
  SESSION_SECRET: randomBytes(48).toString("base64"),
});
const prod = (extra: Record<string, string> = {}) => ({ ...base, ...strong(), NODE_ENV: "production", INTEGRATIONS_MODE: "fake", ...extra });
const errors = (r: ReturnType<typeof parseEnv>) => r.error?.flatten().fieldErrors ?? {};

describe("environment schema", () => {
  it("refuses to start in production without an explicit INTEGRATIONS_MODE", () => {
    const { INTEGRATIONS_MODE: _m, ...noMode } = prod();
    const r = parseEnv(noMode);
    expect(r.success).toBe(false);
    expect(errors(r).INTEGRATIONS_MODE?.[0]).toMatch(/explicitly/);
  });

  it("accepts production with an explicit mode and strong secrets", () => {
    expect(parseEnv(prod()).success).toBe(true);
  });

  it("defaults to fake outside production and treats REDIS_URL as optional", () => {
    const r = parseEnv({ ...base, NODE_ENV: "development" });
    expect(r.data?.INTEGRATIONS_MODE).toBe("fake");
    expect(r.data?.REDIS_URL).toBeUndefined();
  });

  it("requires a valid OPS_EMAIL", () => {
    expect(parseEnv({ ...base, OPS_EMAIL: "not-an-email" }).success).toBe(false);
    const { OPS_EMAIL: _omit, ...rest } = base;
    expect(parseEnv(rest).success).toBe(false);
  });

  it("requires RESEND_API_KEY and MESSAGING_FROM only when the mode is test or live (with Resend as provider)", () => {
    const resend = { ...base, MESSAGING_PROVIDER: "resend" };
    expect(parseEnv({ ...resend }).success).toBe(true); // fake mode: the fake adapter is used, nothing required
    const stripe = { PAYMENTS_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: "whsec_xxx" };
    for (const [mode, key] of [["test", "sk_test_xxx"], ["live", "sk_live_xxx"]] as const) {
      const alert = mode === "live" ? { ALERT_WEBHOOK_URL: "https://hooks.example.com/x" } : {};
      const missing = parseEnv({ ...resend, ...stripe, ...alert, STRIPE_SECRET_KEY: key, INTEGRATIONS_MODE: mode });
      expect(Object.keys(errors(missing)).sort()).toEqual(["MESSAGING_FROM", "RESEND_API_KEY"]);
      expect(parseEnv({ ...resend, ...stripe, ...alert, STRIPE_SECRET_KEY: key, INTEGRATIONS_MODE: mode, RESEND_API_KEY: "re_abc_123", MESSAGING_FROM: "OctavoLab <noreply@example.com>" }).success).toBe(true);
    }
  });

  it("validates the Resend key and sender format without echoing the value", () => {
    const r = parseEnv({ ...base, MESSAGING_PROVIDER: "resend", INTEGRATIONS_MODE: "fake", RESEND_API_KEY: "sk_live_secret_value", MESSAGING_FROM: "noreply@example.com\r\nBcc: x@y.co" });
    expect(Object.keys(errors(r)).sort()).toEqual(["MESSAGING_FROM", "RESEND_API_KEY"]);
    expect(JSON.stringify(errors(r))).not.toContain("sk_live_secret_value");
    expect(parseEnv({ ...base, MESSAGING_FROM: "noreply@example.com" }).success).toBe(true);
  });

  it("2FA: REQUIRE_PRIVILEGED_2FA defaults to false, needs TOTP_ENC_KEY when true, and the key must be 32 bytes in base64", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    expect(parseEnv(base).data?.REQUIRE_PRIVILEGED_2FA).toBe(false);
    expect(parseEnv(base).data?.TOTP_ISSUER).toBe("OctavoLab");
    const missing = parseEnv({ ...base, REQUIRE_PRIVILEGED_2FA: "true" });
    expect(missing.error?.flatten().fieldErrors.TOTP_ENC_KEY?.[0]).toMatch(/REQUIRE_PRIVILEGED_2FA/);
    expect(parseEnv({ ...base, REQUIRE_PRIVILEGED_2FA: "true", TOTP_ENC_KEY: key }).data?.REQUIRE_PRIVILEGED_2FA).toBe(true);
    const short = parseEnv({ ...base, TOTP_ENC_KEY: Buffer.alloc(16, 1).toString("base64") });
    expect(short.error?.flatten().fieldErrors.TOTP_ENC_KEY?.[0]).toMatch(/32 random bytes/);
    expect(JSON.stringify(short.error?.flatten())).not.toContain(Buffer.alloc(16, 1).toString("base64"));
    expect(parseEnv({ ...base, REQUIRE_PRIVILEGED_2FA: "yes" }).success).toBe(false);
    // Old name still works; the new name wins when both are set.
    expect(parseEnv({ ...base, REQUIRE_OWNER_2FA: "true", TOTP_ENC_KEY: key }).data?.REQUIRE_PRIVILEGED_2FA).toBe(true);
    expect(parseEnv({ ...base, REQUIRE_OWNER_2FA: "true", REQUIRE_PRIVILEGED_2FA: "false" }).data?.REQUIRE_PRIVILEGED_2FA).toBe(false);
    expect(parseEnv({ ...base, TOTP_ISSUER: "Bad:Issuer" }).success).toBe(false);
  });
});

describe("INTEGRATIONS_MODE (fake | test | live)", () => {
  it("is normalized case-insensitively; sandbox is accepted as the old name of test; anything else fails fast", () => {
    expect(["FAKE", " Fake ", "fake"].map((m) => parseEnv({ ...base, INTEGRATIONS_MODE: m }).data?.INTEGRATIONS_MODE)).toEqual(["fake", "fake", "fake"]);
    const keys = { PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_xxx", STRIPE_WEBHOOK_SECRET: "whsec_xxx", MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_xxx", MESSAGING_FROM: "noreply@example.com" };
    expect(parseEnv({ ...base, ...keys, INTEGRATIONS_MODE: "Test" }).data?.INTEGRATIONS_MODE).toBe("test");
    expect(parseEnv({ ...base, ...keys, INTEGRATIONS_MODE: "sandbox" }).data?.INTEGRATIONS_MODE).toBe("test");
    const bad = parseEnv({ ...base, INTEGRATIONS_MODE: "prod-LEAK1" });
    expect(errors(bad).INTEGRATIONS_MODE?.[0]).toBe("must be one of fake | test | live (case-insensitive)");
    expect(JSON.stringify(bad.error?.flatten())).not.toContain("LEAK1");
  });

  it("fake needs no provider keys", () => {
    expect(integrationKeyIssues({ INTEGRATIONS_MODE: "fake", PAYMENTS_PROVIDER: "fake", MESSAGING_PROVIDER: "fake" })).toEqual([]);
    expect(parseEnv(prod({ INTEGRATIONS_MODE: "fake" })).success).toBe(true);
  });

  it("test needs Stripe TEST keys and Resend; each missing or wrong key is named", () => {
    const r = parseEnv({ ...base, INTEGRATIONS_MODE: "test" });
    expect(Object.keys(errors(r)).sort()).toEqual(["MESSAGING_PROVIDER", "PAYMENTS_PROVIDER"]);
    const r2 = parseEnv({ ...base, INTEGRATIONS_MODE: "test", PAYMENTS_PROVIDER: "stripe", MESSAGING_PROVIDER: "resend" });
    expect(Object.keys(errors(r2)).sort()).toEqual(["MESSAGING_FROM", "RESEND_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
    const wrongKind = parseEnv({ ...base, INTEGRATIONS_MODE: "test", PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_xxx", STRIPE_WEBHOOK_SECRET: "nope", MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_xxx", MESSAGING_FROM: "noreply@example.com" });
    expect(errors(wrongKind).STRIPE_SECRET_KEY?.[0]).toMatch(/Stripe test key/);
    expect(errors(wrongKind).STRIPE_WEBHOOK_SECRET?.[0]).toMatch(/whsec_/);
    expect(parseEnv({ ...base, INTEGRATIONS_MODE: "test", PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "rk_test_xxx", STRIPE_WEBHOOK_SECRET: "whsec_xxx", MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_xxx", MESSAGING_FROM: "noreply@example.com" }).success).toBe(true);
  });

  it("live needs Stripe LIVE keys", () => {
    const keys = { PAYMENTS_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: "whsec_xxx", MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_xxx", MESSAGING_FROM: "noreply@example.com", ALERT_WEBHOOK_URL: "https://hooks.example.com/x" };
    expect(errors(parseEnv({ ...base, ...keys, INTEGRATIONS_MODE: "live", STRIPE_SECRET_KEY: "sk_test_xxx" })).STRIPE_SECRET_KEY?.[0]).toMatch(/Stripe live key/);
    expect(parseEnv({ ...base, ...keys, INTEGRATIONS_MODE: "LIVE", STRIPE_SECRET_KEY: "sk_live_xxx" }).success).toBe(true);
  });
});

describe("production secrets (refuse to boot when missing or weak)", () => {
  it("SESSION_SECRET: length, placeholders, distinct characters and entropy", () => {
    for (const weak of ["a".repeat(40), "change-me-32-chars-minimum-random", "ci-only-secret-that-is-at-least-32-chars", "abababababababababababababababababab", "0123456789abcdef0123456789abcdef"]) {
      const r = parseEnv(prod({ SESSION_SECRET: weak }));
      expect(errors(r).SESSION_SECRET?.length, weak).toBeGreaterThan(0);
      expect(JSON.stringify(r.error?.flatten())).not.toContain(weak);
    }
    expect(errors(parseEnv(prod({ SESSION_SECRET: randomBytes(32).toString("hex") }))).SESSION_SECRET).toBeUndefined();
  });
  it("DATABASE_URL: needs a real password and must not point at localhost", () => {
    expect(errors(parseEnv(prod({ DATABASE_URL: "postgresql://app:app@db.example:5432/app" }))).DATABASE_URL?.[0]).toMatch(/at least 16/);
    expect(errors(parseEnv(prod({ DATABASE_URL: `postgresql://app:${randomBytes(24).toString("hex")}@localhost:5432/app` }))).DATABASE_URL?.[0]).toMatch(/localhost/);
    expect(errors(parseEnv(prod({ DATABASE_URL: "postgresql://app:password-password-1@db.example:5432/app" }))).DATABASE_URL?.[0]).toMatch(/placeholder/);
  });
  it("TOTP_ENC_KEY: a non-random 32-byte key is refused", () => {
    expect(errors(parseEnv(prod({ TOTP_ENC_KEY: Buffer.alloc(32, 7).toString("base64") }))).TOTP_ENC_KEY?.[0]).toMatch(/not random/);
    expect(parseEnv(prod({ TOTP_ENC_KEY: randomBytes(32).toString("base64"), REQUIRE_PRIVILEGED_2FA: "true" })).success).toBe(true);
  });
  it("outside production the strength checks do not apply (local dev and CI keep their simple values)", () => {
    expect(parseEnv({ ...base, NODE_ENV: "development" }).success).toBe(true);
  });
});

describe("removed env-var owner bootstrap", () => {
  it("BOOTSTRAP_* variables hard-fail in production, without echoing their values", () => {
    const r = parseEnv(prod({ BOOTSTRAP_OWNER_EMAIL: "o@example.com", BOOTSTRAP_OWNER_PASSWORD: "LEAK1-password-value" }));
    expect(Object.keys(errors(r)).sort()).toEqual(["BOOTSTRAP_OWNER_EMAIL", "BOOTSTRAP_OWNER_PASSWORD"]);
    expect((errors(r) as Record<string, string[] | undefined>).BOOTSTRAP_OWNER_PASSWORD?.[0]).toMatch(/create-owner/);
    expect(JSON.stringify(r.error?.flatten())).not.toContain("LEAK1");
    expect(parseEnv({ ...base, NODE_ENV: "development", BOOTSTRAP_OWNER_EMAIL: "o@example.com" }).success).toBe(true);
  });
});

describe("version baked into the image", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "version-"));
  it("reads a git SHA from the VERSION file; anything else (or no file) is dev; never the environment", () => {
    const f = path.join(dir, "VERSION");
    writeFileSync(f, "5cae0a9\n");
    expect(readBuildVersion(f)).toBe("5cae0a9");
    writeFileSync(f, "unknown");
    expect(readBuildVersion(f)).toBe("dev");
    expect(readBuildVersion(path.join(dir, "missing"))).toBe("dev");
    process.env.APP_VERSION = "9553b0e";
    expect(readBuildVersion(path.join(dir, "missing"))).toBe("dev");
    delete process.env.APP_VERSION;
  });
  it("alerts: ALERT_WEBHOOK_URL is required in live mode, must be https, is never echoed, and the mfa threshold defaults to 10", () => {
    const live = { ...base, NODE_ENV: "production", INTEGRATIONS_MODE: "live" };
    expect(parseEnv(live).error?.flatten().fieldErrors.ALERT_WEBHOOK_URL?.[0]).toMatch(/required when INTEGRATIONS_MODE=live/);
    const plain = parseEnv({ ...live, ALERT_WEBHOOK_URL: "http://hooks.example.com/secret-token-123" });
    expect(plain.error?.flatten().fieldErrors.ALERT_WEBHOOK_URL?.[0]).toMatch(/https/);
    expect(JSON.stringify(plain.error?.flatten())).not.toContain("secret-token-123"); // the URL is a credential
    expect(parseEnv({ ...live, ALERT_WEBHOOK_URL: "https://hooks.example.com/x" }).error?.flatten().fieldErrors.ALERT_WEBHOOK_URL).toBeUndefined();
    expect(parseEnv({ ...base, NODE_ENV: "development" }).data?.MFA_FAILED_ALERT_THRESHOLD).toBe(10);
  });
});
