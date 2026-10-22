import { describe, it, expect } from "vitest";

Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "http://localhost:5173", OPS_EMAIL: "ops@test.invalid" });
const { parseEnv } = await import("./env.js");

const base = { DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "https://app.example.com", OPS_EMAIL: "ops@test.invalid" };

describe("environment schema", () => {
  it("refuses to start in production unless every integration mode resolves explicitly, naming the missing variables", () => {
    const r = parseEnv({ ...base, NODE_ENV: "production", APP_ENV: "staging" });
    expect(r.success).toBe(false);
    const errs = r.error?.flatten().fieldErrors ?? {};
    expect(Object.keys(errs).sort()).toEqual(["CARRIER_MODE", "MESSAGING_MODE", "PAYMENTS_MODE", "STORAGE_MODE"]);
    expect(errs.PAYMENTS_MODE?.[0]).toMatch(/explicitly/);
    const one = parseEnv({ ...base, NODE_ENV: "production", APP_ENV: "staging", PAYMENTS_MODE: "fake", MESSAGING_MODE: "fake", STORAGE_MODE: "fake" });
    expect(Object.keys(one.error?.flatten().fieldErrors ?? {})).toEqual(["CARRIER_MODE"]);
  });

  it("requires APP_ENV in production (deploy.sh sets it)", () => {
    const r = parseEnv({ ...base, NODE_ENV: "production", INTEGRATIONS_MODE: "fake" });
    expect(Object.keys(r.error?.flatten().fieldErrors ?? {})).toEqual(["APP_ENV"]);
  });

  it("accepts production with an explicit mode, including fake for a demo; INTEGRATIONS_MODE is the default of every mode", () => {
    const stripe = { PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_xxx", STRIPE_WEBHOOK_SECRET: "whsec_xxx" };
    const r = parseEnv({ ...base, NODE_ENV: "production", APP_ENV: "staging", INTEGRATIONS_MODE: "fake", PAYMENTS_MODE: "sandbox", ...stripe });
    expect(r.data?.MODES).toEqual({ payments: "sandbox", messaging: "fake", carrier: "fake", storage: "fake" });
    expect(parseEnv({ ...base, NODE_ENV: "production", APP_ENV: "production", INTEGRATIONS_MODE: "fake" }).success).toBe(true);
  });

  it("defaults to fake outside production and treats REDIS_URL as optional", () => {
    const r = parseEnv({ ...base, NODE_ENV: "development" });
    expect(r.data?.INTEGRATIONS_MODE).toBe("fake");
    expect(r.data?.MODES).toEqual({ payments: "fake", messaging: "fake", carrier: "fake", storage: "fake" });
    expect(r.data?.APP_ENV).toBe("local");
    expect(r.data?.REDIS_URL).toBeUndefined();
  });

  it("live for any integration requires ALLOW_LIVE=true, which is only accepted with APP_ENV=production", () => {
    const live = { ...base, NODE_ENV: "production", PAYMENTS_MODE: "live", MESSAGING_MODE: "fake", CARRIER_MODE: "fake", STORAGE_MODE: "fake", PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_xxx", STRIPE_WEBHOOK_SECRET: "whsec_xxx" };
    expect(parseEnv({ ...live, APP_ENV: "production" }).error?.flatten().fieldErrors.PAYMENTS_MODE?.[0]).toMatch(/ALLOW_LIVE=true/);
    expect(Object.keys(parseEnv({ ...live, APP_ENV: "staging", ALLOW_LIVE: "true" }).error?.flatten().fieldErrors ?? {})).toEqual(["ALLOW_LIVE"]);
    expect(parseEnv({ ...live, APP_ENV: "production", ALLOW_LIVE: "true" }).success).toBe(true);
  });

  it("rejects a Stripe key whose mode does not match, without echoing it", () => {
    const liveKey = ["sk", "live", "LEAK1"].join("_"); // built at runtime: a placeholder, not a credential
    const r = parseEnv({ ...base, PAYMENTS_MODE: "sandbox", PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: liveKey, STRIPE_WEBHOOK_SECRET: "whsec_xxx" });
    expect(r.error?.flatten().fieldErrors.STRIPE_SECRET_KEY?.[0]).toMatch(/test key/);
    expect(JSON.stringify(r.error?.flatten())).not.toContain("LEAK1");
  });

  it("staging defaults MESSAGING_FROM to the verified 24hcargo.com sender", () => {
    const r = parseEnv({ ...base, APP_ENV: "staging", MESSAGING_MODE: "sandbox", MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_abc_123" });
    expect(r.data?.MESSAGING_FROM).toBe("OctavoLab Staging <noreply@24hcargo.com>");
  });

  it("requires a valid OPS_EMAIL", () => {
    expect(parseEnv({ ...base, OPS_EMAIL: "not-an-email" }).success).toBe(false);
    const { OPS_EMAIL: _omit, ...rest } = base;
    expect(parseEnv(rest).success).toBe(false);
  });

  it("requires RESEND_API_KEY and MESSAGING_FROM only when MESSAGING_PROVIDER=resend in sandbox or live mode", () => {
    const resend = { ...base, MESSAGING_PROVIDER: "resend" };
    expect(parseEnv({ ...resend }).success).toBe(true); // fake mode: the fake adapter is used, nothing required
    for (const [mode, extra] of [["sandbox", {}], ["live", { ALLOW_LIVE: "true", APP_ENV: "production" }]] as const) {
      const missing = parseEnv({ ...resend, ...extra, MESSAGING_MODE: mode });
      expect(Object.keys(missing.error?.flatten().fieldErrors ?? {}).sort()).toEqual(["MESSAGING_FROM", "RESEND_API_KEY"]);
      expect(parseEnv({ ...resend, ...extra, MESSAGING_MODE: mode, RESEND_API_KEY: "re_abc_123", MESSAGING_FROM: "OctavoLab <noreply@example.com>" }).success).toBe(true);
    }
    // A real mode with no implemented provider is a boot error now (it used to fail at the first send).
    expect(parseEnv({ ...base, MESSAGING_MODE: "sandbox" }).error?.flatten().fieldErrors.MESSAGING_PROVIDER?.[0]).toMatch(/must be resend/);
  });

  it("validates the Resend key and sender format without echoing the value", () => {
    const r = parseEnv({ ...base, MESSAGING_PROVIDER: "resend", MESSAGING_MODE: "sandbox", RESEND_API_KEY: "sk_live_secret_value", MESSAGING_FROM: "noreply@example.com\r\nBcc: x@y.co" });
    const errs = r.error?.flatten().fieldErrors ?? {};
    expect(Object.keys(errs).sort()).toEqual(["MESSAGING_FROM", "RESEND_API_KEY"]);
    expect(JSON.stringify(errs)).not.toContain("sk_live_secret_value");
    expect(parseEnv({ ...base, MESSAGING_FROM: "noreply@example.com" }).success).toBe(true);
  });

  it("2FA: REQUIRE_OWNER_2FA defaults to false, needs TOTP_ENC_KEY when true, and the key must be 32 bytes in base64", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    expect(parseEnv(base).data?.REQUIRE_OWNER_2FA).toBe(false);
    expect(parseEnv(base).data?.TOTP_ISSUER).toBe("OctavoLab");
    const missing = parseEnv({ ...base, REQUIRE_OWNER_2FA: "true" });
    expect(missing.error?.flatten().fieldErrors.TOTP_ENC_KEY?.[0]).toMatch(/REQUIRE_OWNER_2FA/);
    expect(parseEnv({ ...base, REQUIRE_OWNER_2FA: "true", TOTP_ENC_KEY: key }).data?.REQUIRE_OWNER_2FA).toBe(true);
    const short = parseEnv({ ...base, TOTP_ENC_KEY: Buffer.alloc(16, 1).toString("base64") });
    expect(short.error?.flatten().fieldErrors.TOTP_ENC_KEY?.[0]).toMatch(/32 random bytes/);
    expect(JSON.stringify(short.error?.flatten())).not.toContain(Buffer.alloc(16, 1).toString("base64"));
    expect(parseEnv({ ...base, REQUIRE_OWNER_2FA: "yes" }).success).toBe(false);
    expect(parseEnv({ ...base, TOTP_ISSUER: "Bad:Issuer" }).success).toBe(false);
  });
});
