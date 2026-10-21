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
});
