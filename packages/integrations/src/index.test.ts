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
});
