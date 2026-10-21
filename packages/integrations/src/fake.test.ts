import { describe, it, expect } from "vitest";
import { FakeCarrier } from "./fake.js";
describe("FakeCarrier", () => {
  it("bills the greater of real and volumetric weight", async () => {
    const [q] = await new FakeCarrier().quote({ from: "GB", to: "CO", weightKg: 2, volumetricKg: 5 });
    expect(q?.money.amount).toBe(6250);
  });
});
