import { describe, it, expect, vi } from "vitest";
describe("adapter selection", () => {
  it("never returns a fake carrier or messaging adapter outside fake mode", async () => {
    vi.resetModules();
    process.env.INTEGRATIONS_MODE = "live";
    const mod = await import("./index.js");
    expect(() => mod.getCarrier()).toThrow();
    expect(() => mod.getMessaging()).toThrow();
    process.env.INTEGRATIONS_MODE = "fake";
  });
  it("refuses to load in production without an explicit INTEGRATIONS_MODE", async () => {
    vi.resetModules();
    const prev = { NODE_ENV: process.env.NODE_ENV, MODE: process.env.INTEGRATIONS_MODE };
    process.env.NODE_ENV = "production";
    delete process.env.INTEGRATIONS_MODE;
    await expect(import("./index.js")).rejects.toThrow("INTEGRATIONS_MODE must be set explicitly");
    process.env.NODE_ENV = prev.NODE_ENV;
    process.env.INTEGRATIONS_MODE = prev.MODE ?? "fake";
  });
  it("selects Resend only when MESSAGING_PROVIDER=resend in sandbox or live mode; fake stays the default", async () => {
    const prev = { ...process.env };
    try {
      Object.assign(process.env, { MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_TestKey_1234", MESSAGING_FROM: "noreply@example.com" });
      for (const [mode, name] of [["fake", "fake-messaging"], ["sandbox", "resend"], ["live", "resend"]] as const) {
        vi.resetModules();
        process.env.INTEGRATIONS_MODE = mode;
        expect((await import("./index.js")).getMessaging().name).toBe(name);
      }
      vi.resetModules();
      process.env.INTEGRATIONS_MODE = "live";
      delete process.env.RESEND_API_KEY;
      const mod = await import("./index.js");
      expect(() => mod.getMessaging()).toThrow("RESEND_API_KEY missing");
    } finally {
      for (const k of ["MESSAGING_PROVIDER", "RESEND_API_KEY", "MESSAGING_FROM"]) delete process.env[k];
      process.env.INTEGRATIONS_MODE = prev.INTEGRATIONS_MODE ?? "fake";
    }
  });
});
