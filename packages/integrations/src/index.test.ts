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
});
