import { describe, it, expect } from "vitest";
import { validateIntegrationEnv, resolveMode, resolveModes, messagingFrom, messagingAllowList, assertIntegrationEnv, stripeKeyMatchesMode, STAGING_MESSAGING_FROM } from "./config.js";

const paths = (env: Record<string, string>) => validateIntegrationEnv(env).map((i) => i.path).sort();
const stripe = { PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_xxx", STRIPE_WEBHOOK_SECRET: "whsec_xxx" };
const resend = { MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_xxx", MESSAGING_FROM: "OctavoLab <noreply@example.com>" };
const oes = { CARRIER_PROVIDER: "oes", OES_API_URL: "https://oes.example.invalid", OES_API_KEY: "oes_xxx", OES_QUOTE_PATH: "/v1/quotes" };
const s3 = { STORAGE_PROVIDER: "s3", S3_ENDPOINT: "https://s3.eu-west-2.amazonaws.com", S3_BUCKET: "octavolab-staging-files", S3_ACCESS_KEY: "TESTACCESSKEYID00000", S3_SECRET_KEY: "xxx" };

describe("mode resolution", () => {
  it("each integration defaults to INTEGRATIONS_MODE, then to fake outside production (backward compatible)", () => {
    expect(resolveModes({})).toEqual({ payments: "fake", messaging: "fake", carrier: "fake", storage: "fake" });
    expect(resolveModes({ INTEGRATIONS_MODE: "sandbox" })).toEqual({ payments: "sandbox", messaging: "sandbox", carrier: "sandbox", storage: "sandbox" });
    expect(resolveModes({ INTEGRATIONS_MODE: "fake", PAYMENTS_MODE: "sandbox", STORAGE_MODE: " " })).toEqual({ payments: "sandbox", messaging: "fake", carrier: "fake", storage: "fake" });
  });

  it("production never defaults: an unresolved mode is undefined and resolveModes throws naming the variable", () => {
    expect(resolveMode({ NODE_ENV: "production" }, "carrier")).toBeUndefined();
    expect(() => resolveModes({ NODE_ENV: "production", PAYMENTS_MODE: "fake", MESSAGING_MODE: "fake", STORAGE_MODE: "fake" })).toThrow("CARRIER_MODE (or INTEGRATIONS_MODE) must be set explicitly in production");
    expect(resolveMode({ NODE_ENV: "production", INTEGRATIONS_MODE: "bogus" }, "payments")).toBeUndefined();
    expect(resolveMode({ PAYMENTS_MODE: "bogus" }, "payments")).toBeUndefined();
  });
});

describe("validateIntegrationEnv", () => {
  it("accepts an empty development environment and an all-fake production", () => {
    expect(paths({})).toEqual([]);
    expect(paths({ NODE_ENV: "production", INTEGRATIONS_MODE: "fake" })).toEqual([]);
  });

  it("in production names every mode variable that does not resolve", () => {
    expect(paths({ NODE_ENV: "production" })).toEqual(["CARRIER_MODE", "MESSAGING_MODE", "PAYMENTS_MODE", "STORAGE_MODE"]);
    const [issue] = validateIntegrationEnv({ NODE_ENV: "production", PAYMENTS_MODE: "fake", MESSAGING_MODE: "fake", STORAGE_MODE: "fake" });
    expect(issue).toEqual({ path: "CARRIER_MODE", message: expect.stringMatching(/explicitly in production/) });
  });

  it("rejects unknown mode values", () => {
    expect(paths({ INTEGRATIONS_MODE: "prod", PAYMENTS_MODE: "test" })).toEqual(["INTEGRATIONS_MODE", "PAYMENTS_MODE"]);
  });

  it("live requires ALLOW_LIVE=true, and ALLOW_LIVE=true requires APP_ENV=production", () => {
    const live = { PAYMENTS_MODE: "live", ...stripe, STRIPE_SECRET_KEY: "sk_live_xxx" };
    expect(validateIntegrationEnv(live)).toEqual([{ path: "PAYMENTS_MODE", message: expect.stringMatching(/ALLOW_LIVE=true/) }]);
    expect(paths({ ...live, ALLOW_LIVE: "true" })).toEqual(["ALLOW_LIVE"]);
    expect(paths({ ...live, ALLOW_LIVE: "true", APP_ENV: "staging" })).toEqual(["ALLOW_LIVE"]);
    expect(paths({ ...live, ALLOW_LIVE: "true", APP_ENV: "production" })).toEqual([]);
    expect(paths({ ALLOW_LIVE: "yes" })).toEqual(["ALLOW_LIVE"]);
    expect(paths({ ALLOW_LIVE: "false" })).toEqual([]);
  });

  it("a non-fake mode needs an implemented provider", () => {
    expect(paths({ INTEGRATIONS_MODE: "sandbox" })).toEqual(["CARRIER_PROVIDER", "MESSAGING_PROVIDER", "PAYMENTS_PROVIDER", "STORAGE_PROVIDER"]);
    expect(validateIntegrationEnv({ PAYMENTS_MODE: "sandbox", PAYMENTS_PROVIDER: "wompi" })[0]?.message).toMatch(/must be stripe/);
    expect(paths({ INTEGRATIONS_MODE: "sandbox", ...stripe, ...resend, ...oes, ...s3 })).toEqual([]);
  });

  it("Stripe: test key in sandbox, live key in live, webhook secret always", () => {
    expect(paths({ PAYMENTS_MODE: "sandbox", PAYMENTS_PROVIDER: "stripe" })).toEqual(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
    expect(validateIntegrationEnv({ PAYMENTS_MODE: "sandbox", ...stripe, STRIPE_SECRET_KEY: "sk_live_xxx" })).toEqual([{ path: "STRIPE_SECRET_KEY", message: expect.stringMatching(/test key/) }]);
    const live = { PAYMENTS_MODE: "live", ALLOW_LIVE: "true", APP_ENV: "production", ...stripe };
    expect(validateIntegrationEnv(live)).toEqual([{ path: "STRIPE_SECRET_KEY", message: expect.stringMatching(/live key/) }]);
    expect(paths({ PAYMENTS_MODE: "sandbox", ...stripe, STRIPE_SECRET_KEY: "rk_test_xxx" })).toEqual([]);
    expect(paths({ PAYMENTS_MODE: "sandbox", ...stripe, STRIPE_WEBHOOK_SECRET: "secret" })).toEqual(["STRIPE_WEBHOOK_SECRET"]);
  });

  it("never puts a submitted secret value in a message", () => {
    const liveKey = ["sk", "live", "LEAK1"].join("_"); // built at runtime: a placeholder, not a credential
    const leaky = { PAYMENTS_MODE: "sandbox", ...stripe, STRIPE_SECRET_KEY: liveKey, RESEND_API_KEY: "LEAK1", MESSAGING_MODE: "sandbox", MESSAGING_PROVIDER: "resend" };
    expect(JSON.stringify(validateIntegrationEnv(leaky))).not.toContain("LEAK1");
  });

  it("Resend: key and sender required; MESSAGING_FROM defaults only on staging; allow list is sandbox-only and must be emails", () => {
    expect(paths({ MESSAGING_MODE: "sandbox", MESSAGING_PROVIDER: "resend" })).toEqual(["MESSAGING_FROM", "RESEND_API_KEY"]);
    expect(paths({ MESSAGING_MODE: "sandbox", MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_xxx", APP_ENV: "staging" })).toEqual([]);
    expect(paths({ MESSAGING_MODE: "sandbox", ...resend, RESEND_API_KEY: "sk_xxx" })).toEqual(["RESEND_API_KEY"]);
    expect(paths({ MESSAGING_MODE: "sandbox", ...resend, MESSAGING_ALLOW_LIST: "jaime@example.com, ops@example.com" })).toEqual([]);
    expect(paths({ MESSAGING_MODE: "sandbox", ...resend, MESSAGING_ALLOW_LIST: "jaime@example.com,not-an-email" })).toEqual(["MESSAGING_ALLOW_LIST"]);
    expect(paths({ MESSAGING_MODE: "live", ALLOW_LIVE: "true", APP_ENV: "production", ...resend, MESSAGING_ALLOW_LIST: "jaime@example.com" })).toEqual(["MESSAGING_ALLOW_LIST"]);
  });

  it("OES: URL (https), key and quote path required in sandbox or live", () => {
    expect(paths({ CARRIER_MODE: "sandbox", CARRIER_PROVIDER: "oes" })).toEqual(["OES_API_KEY", "OES_API_URL", "OES_QUOTE_PATH"]);
    expect(paths({ CARRIER_MODE: "sandbox", ...oes, OES_API_URL: "http://oes.example.invalid", OES_QUOTE_PATH: "quotes" })).toEqual(["OES_API_URL", "OES_QUOTE_PATH"]);
    expect(paths({ CARRIER_MODE: "sandbox", ...oes, OES_API_URL: "not a url" })).toEqual(["OES_API_URL"]);
  });

  it("S3: endpoint (https), bucket, access key and secret required in sandbox or live", () => {
    expect(paths({ STORAGE_MODE: "sandbox", STORAGE_PROVIDER: "s3" })).toEqual(["S3_ACCESS_KEY", "S3_BUCKET", "S3_ENDPOINT", "S3_SECRET_KEY"]);
    expect(paths({ STORAGE_MODE: "sandbox", ...s3, S3_ENDPOINT: "http://x", S3_BUCKET: "Bad_Bucket", S3_ACCESS_KEY: "lower" })).toEqual(["S3_ACCESS_KEY", "S3_BUCKET", "S3_ENDPOINT"]);
  });

  it("assertIntegrationEnv throws the first issue with the variable name", () => {
    expect(() => assertIntegrationEnv({ PAYMENTS_MODE: "sandbox", PAYMENTS_PROVIDER: "stripe" })).toThrow("invalid integration configuration: STRIPE_SECRET_KEY required when PAYMENTS_MODE is sandbox");
    expect(() => assertIntegrationEnv({})).not.toThrow();
  });
});

describe("helpers", () => {
  it("messagingFrom applies the staging default only when unset", () => {
    expect(messagingFrom({ APP_ENV: "staging" })).toBe(STAGING_MESSAGING_FROM);
    expect(STAGING_MESSAGING_FROM).toBe("OctavoLab Staging <noreply@24hcargo.com>");
    expect(messagingFrom({ APP_ENV: "staging", MESSAGING_FROM: "a@b.co" })).toBe("a@b.co");
    expect(messagingFrom({ APP_ENV: "production" })).toBeUndefined();
  });
  it("messagingAllowList trims, lower-cases and drops blanks", () => {
    expect(messagingAllowList({ MESSAGING_ALLOW_LIST: " Jaime@Example.com,, ops@example.com " })).toEqual(["jaime@example.com", "ops@example.com"]);
    expect(messagingAllowList({})).toEqual([]);
  });
  it("stripeKeyMatchesMode", () => {
    expect([stripeKeyMatchesMode("sk_test_a1", "sandbox"), stripeKeyMatchesMode("sk_live_a1", "sandbox"), stripeKeyMatchesMode("rk_live_a1", "live"), stripeKeyMatchesMode("pk_live_a1", "live")]).toEqual([true, false, true, false]);
  });
});
