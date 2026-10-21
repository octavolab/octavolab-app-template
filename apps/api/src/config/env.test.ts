import { describe, it, expect } from "vitest";

Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "http://localhost:5173", OPS_EMAIL: "ops@test.invalid" });
const { parseEnv } = await import("./env.js");

const base = { DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "https://app.example.com", OPS_EMAIL: "ops@test.invalid" };

describe("environment schema", () => {
  it("refuses to start in production without an explicit INTEGRATIONS_MODE", () => {
    const r = parseEnv({ ...base, NODE_ENV: "production" });
    expect(r.success).toBe(false);
    expect(r.error?.flatten().fieldErrors.INTEGRATIONS_MODE?.[0]).toMatch(/explicitly/);
  });

  it("accepts production with an explicit mode, including fake for a demo", () => {
    expect(parseEnv({ ...base, NODE_ENV: "production", INTEGRATIONS_MODE: "sandbox" }).data?.INTEGRATIONS_MODE).toBe("sandbox");
    expect(parseEnv({ ...base, NODE_ENV: "production", INTEGRATIONS_MODE: "fake" }).success).toBe(true);
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

  it("requires RESEND_API_KEY and MESSAGING_FROM only when MESSAGING_PROVIDER=resend in sandbox or live mode", () => {
    const resend = { ...base, MESSAGING_PROVIDER: "resend" };
    expect(parseEnv({ ...resend }).success).toBe(true); // fake mode: the fake adapter is used, nothing required
    for (const mode of ["sandbox", "live"]) {
      const missing = parseEnv({ ...resend, INTEGRATIONS_MODE: mode });
      expect(Object.keys(missing.error?.flatten().fieldErrors ?? {}).sort()).toEqual(["MESSAGING_FROM", "RESEND_API_KEY"]);
      expect(parseEnv({ ...resend, INTEGRATIONS_MODE: mode, RESEND_API_KEY: "re_abc_123", MESSAGING_FROM: "OctavoLab <noreply@example.com>" }).success).toBe(true);
    }
    expect(parseEnv({ ...base, INTEGRATIONS_MODE: "live" }).success).toBe(true); // provider fake: not required
  });

  it("validates the Resend key and sender format without echoing the value", () => {
    const r = parseEnv({ ...base, MESSAGING_PROVIDER: "resend", INTEGRATIONS_MODE: "live", RESEND_API_KEY: "sk_live_secret_value", MESSAGING_FROM: "noreply@example.com\r\nBcc: x@y.co" });
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
