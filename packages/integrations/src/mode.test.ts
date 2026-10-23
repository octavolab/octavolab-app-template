import { describe, it, expect } from "vitest";
import { normalizeIntegrationsMode, integrationsModeFrom, INTEGRATION_MODES } from "./mode.js";

describe("INTEGRATIONS_MODE enum", () => {
  it("accepts fake | test | live case-insensitively and trimmed", () => {
    expect(INTEGRATION_MODES).toEqual(["fake", "test", "live"]);
    expect(["fake", "FAKE", " Fake ", "test", "TEST", "live", "Live"].map(normalizeIntegrationsMode)).toEqual(["fake", "fake", "fake", "test", "test", "live", "live"]);
  });
  it("maps the deprecated name sandbox to test", () => {
    expect([normalizeIntegrationsMode("sandbox"), normalizeIntegrationsMode("SANDBOX")]).toEqual(["test", "test"]);
  });
  it("rejects anything else", () => {
    for (const v of ["", "prod", "production", "fake1", "tes", "__proto__", "constructor"]) expect(normalizeIntegrationsMode(v)).toBeUndefined();
    expect(normalizeIntegrationsMode(undefined)).toBeUndefined();
  });
  it("integrationsModeFrom: fake by default outside production, explicit in production, fails fast on invalid values without echoing them", () => {
    expect(integrationsModeFrom({})).toBe("fake");
    expect(integrationsModeFrom({ INTEGRATIONS_MODE: " " })).toBe("fake");
    expect(integrationsModeFrom({ NODE_ENV: "production", INTEGRATIONS_MODE: "Fake" })).toBe("fake");
    expect(() => integrationsModeFrom({ NODE_ENV: "production" })).toThrow("INTEGRATIONS_MODE must be set explicitly in production");
    expect(() => integrationsModeFrom({ INTEGRATIONS_MODE: "pr0d-secret" })).toThrow(/^INTEGRATIONS_MODE must be one of fake \| test \| live \(case-insensitive\)$/);
  });
});
