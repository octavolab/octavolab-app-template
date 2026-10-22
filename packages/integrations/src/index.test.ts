import { describe, it, expect, vi, afterEach } from "vitest";

const saved = { ...process.env };
const SECRETS = { STRIPE_SECRET_KEY: "sk_test_xxx", STRIPE_WEBHOOK_SECRET: "whsec_xxx", RESEND_API_KEY: "re_TestKey_1234", MESSAGING_FROM: "noreply@example.com",
  OES_API_URL: "https://oes.example.invalid", OES_API_KEY: "oes_xxx", OES_QUOTE_PATH: "/quotes",
  S3_ENDPOINT: "https://s3.eu-west-2.amazonaws.com", S3_BUCKET: "octavolab-staging-files", S3_ACCESS_KEY: "TESTACCESSKEYID00000", S3_SECRET_KEY: "xxx" };
const PROVIDERS = { PAYMENTS_PROVIDER: "stripe", MESSAGING_PROVIDER: "resend", CARRIER_PROVIDER: "oes", STORAGE_PROVIDER: "s3" };
const MODE_KEYS = ["INTEGRATIONS_MODE", "PAYMENTS_MODE", "MESSAGING_MODE", "CARRIER_MODE", "STORAGE_MODE", "ALLOW_LIVE", "APP_ENV", "MESSAGING_ALLOW_LIST"];

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const k of [...MODE_KEYS, ...Object.keys(SECRETS), ...Object.keys(PROVIDERS)]) delete process.env[k];
  Object.assign(process.env, env);
  return import("./index.js");
}
afterEach(() => { process.env = { ...saved }; });

describe("adapter selection (per-integration modes)", () => {
  it("everything is fake by default (local dev and tests unchanged)", async () => {
    const m = await load({});
    expect([m.getPayments().name, m.getMessaging().name, m.getCarrier().name, m.getStorage().name]).toEqual(["fake-payments", "fake-messaging", "fake-carrier", "fake-storage"]);
    expect(m.getStorage()).toBe(m.getStorage());
    await m.getPayments().ping();
    expect(m.integrationModes()).toEqual({ payments: "fake", messaging: "fake", carrier: "fake", storage: "fake" });
  });

  it("INTEGRATIONS_MODE=sandbox still switches every adapter (backward compatible)", async () => {
    const m = await load({ INTEGRATIONS_MODE: "sandbox", ...PROVIDERS, ...SECRETS });
    expect([m.getPayments().name, m.getMessaging().name, m.getCarrier().name, m.getStorage().name]).toEqual(["stripe", "resend", "oes", "s3"]);
  });

  it("each integration can be switched alone: real Stripe + Resend with fake carrier and storage", async () => {
    const m = await load({ INTEGRATIONS_MODE: "fake", PAYMENTS_MODE: "sandbox", MESSAGING_MODE: "sandbox", ...PROVIDERS, ...SECRETS });
    expect([m.getPayments().name, m.getMessaging().name, m.getCarrier().name, m.getStorage().name]).toEqual(["stripe", "resend", "fake-carrier", "fake-storage"]);
  });

  it("caches the OES and S3 adapters per configuration (one circuit breaker per process)", async () => {
    const m = await load({ CARRIER_MODE: "sandbox", STORAGE_MODE: "sandbox", ...PROVIDERS, ...SECRETS });
    expect(m.getCarrier()).toBe(m.getCarrier());
    expect(m.getStorage()).toBe(m.getStorage());
    const first = m.getCarrier();
    process.env.OES_API_KEY = "oes_rotated";
    expect(m.getCarrier()).not.toBe(first);
  });

  it("misconfiguration throws a clear error naming the variable, never a silent fake", async () => {
    let m = await load({ CARRIER_MODE: "sandbox" });
    expect(() => m.getCarrier()).toThrow("CARRIER_PROVIDER must be oes");
    expect(() => m.getPayments()).toThrow("CARRIER_PROVIDER"); // any invalid integration blocks every factory
    m = await load({ PAYMENTS_MODE: "live", ...PROVIDERS, ...SECRETS, STRIPE_SECRET_KEY: "sk_live_xxx" });
    expect(() => m.getPayments()).toThrow("PAYMENTS_MODE live requires ALLOW_LIVE=true");
    m = await load({ MESSAGING_MODE: "sandbox", MESSAGING_PROVIDER: "resend" });
    expect(() => m.getMessaging()).toThrow("RESEND_API_KEY required");
  });

  it("live is possible only with ALLOW_LIVE=true on APP_ENV=production", async () => {
    const m = await load({ PAYMENTS_MODE: "live", ALLOW_LIVE: "true", APP_ENV: "production", ...PROVIDERS, ...SECRETS, STRIPE_SECRET_KEY: "sk_live_xxx" });
    expect(m.getPayments().name).toBe("stripe");
  });

  it("sandbox messaging uses the staging sender default and the allow list", async () => {
    const m = await load({ MESSAGING_MODE: "sandbox", MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_TestKey_1234", APP_ENV: "staging", MESSAGING_ALLOW_LIST: "jaime@example.com" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => { calls.push(String(init.body)); return new Response(JSON.stringify({ id: "x" }), { status: 200 }); });
    try {
      await m.getMessaging().send({ to: "jaime@example.com", template: "order_paid", data: {} });
    } finally { vi.unstubAllGlobals(); }
    expect(JSON.parse(calls[0]!)).toMatchObject({ from: "OctavoLab Staging <noreply@24hcargo.com>", to: ["jaime@example.com"] });
  });

  it("refuses to load in production when a mode does not resolve", async () => {
    await expect(load({ NODE_ENV: "production" })).rejects.toThrow("PAYMENTS_MODE (or INTEGRATIONS_MODE) must be set explicitly in production");
    await expect(load({ NODE_ENV: "production", PAYMENTS_MODE: "fake", MESSAGING_MODE: "fake", STORAGE_MODE: "fake" })).rejects.toThrow("CARRIER_MODE");
    expect((await load({ NODE_ENV: "production", INTEGRATIONS_MODE: "fake" })).getCarrier().name).toBe("fake-carrier");
  });
});
