import { describe, it, expect } from "vitest";
import { OesCarrier } from "./oes.js";

/**
 * Opt-in test against the real OES sandbox. Never runs in CI (no network, no keys there).
 *   OES_SANDBOX_TEST=1 OES_API_URL=<sandbox base URL> OES_API_KEY=<sandbox key> OES_QUOTE_PATH=<path> \
 *     pnpm --filter @octavolab/integrations exec vitest run src/oes.sandbox.test.ts
 * OES_SANDBOX_LANE (optional, "FROM:TO", default "GB:CO") picks a lane OES documents as deterministic in sandbox.
 */
const enabled = process.env.OES_SANDBOX_TEST === "1";

describe.skipIf(!enabled)("OES sandbox (opt-in, real network)", () => {
  it("returns well-formed quotes for a known lane", async () => {
    const [from, to] = (process.env.OES_SANDBOX_LANE ?? "GB:CO").split(":") as [string, string];
    const quotes = await new OesCarrier().quote({ from, to, weightKg: 2, volumetricKg: 3 });
    expect(Array.isArray(quotes)).toBe(true);
    for (const q of quotes) {
      expect(q.carrier).toBeTruthy();
      expect(Number.isSafeInteger(q.money.amount)).toBe(true);
      expect(q.money.currency).toMatch(/^[A-Z]{3}$/);
    }
  }, 20_000);
});
