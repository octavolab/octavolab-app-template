import { describe, expect, it } from "vitest";
import { currencyExponent, formatMoney, minorToMajorInput, parseMajorToMinor } from "./money";

const nbsp = (s: string) => s.replace(/[  ]/g, " ");

describe("formatMoney (minor units + ISO currency)", () => {
  it("formats two-decimal currencies from minor units", () => {
    expect(formatMoney(1500, "GBP", "en-GB")).toBe("£15.00");
    expect(formatMoney(3999, "USD", "en-US")).toBe("$39.99");
    expect(nbsp(formatMoney(1500, "EUR", "es-ES"))).toBe("15,00 €");
  });
  it("uses the ISO exponent providers charge with, not a locale default (COP has 2 minor digits)", () => {
    expect(currencyExponent("COP")).toBe(2);
    expect(nbsp(formatMoney(1500000, "COP", "es-CO"))).toBe("$ 15.000,00");
  });
  it("handles zero-decimal and three-decimal currencies", () => {
    expect(formatMoney(1500, "JPY", "en-US")).toBe("¥1,500");
    expect(formatMoney(1500, "KWD", "en-US")).toMatch(/1\.500/);
  });
  it("is exact for large and awkward amounts", () => {
    expect(formatMoney(2_147_483_647, "GBP", "en-GB")).toBe("£21,474,836.47");
    expect(formatMoney(1, "USD", "en-US")).toBe("$0.01");
    expect(formatMoney(0, "USD", "en-US")).toBe("$0.00");
    expect(formatMoney(-250, "USD", "en-US")).toBe("-$2.50");
  });
  it("rejects non-integer amounts (a float is a bug upstream)", () => {
    expect(() => formatMoney(15.5, "GBP", "en-GB")).toThrow(RangeError);
  });
});

describe("parseMajorToMinor / minorToMajorInput", () => {
  it("parses without floating point drift", () => {
    expect(parseMajorToMinor("15", "GBP")).toBe(1500);
    expect(parseMajorToMinor("15.5", "GBP")).toBe(1550);
    expect(parseMajorToMinor("0,29", "EUR")).toBe(29);
    expect(parseMajorToMinor("19.99", "USD")).toBe(1999);
    expect(parseMajorToMinor("1500", "JPY")).toBe(1500);
  });
  it("rejects invalid, zero, negative or over-precise input", () => {
    for (const bad of ["", "abc", "-1", "0", "0.00", "1.234", "1.5", "1e3"]) {
      expect(parseMajorToMinor(bad, bad === "1.5" ? "JPY" : "GBP")).toBeNull();
    }
  });
  it("round-trips for the edit form", () => {
    expect(minorToMajorInput(1500, "GBP")).toBe("15.00");
    expect(minorToMajorInput(5, "GBP")).toBe("0.05");
    expect(minorToMajorInput(1500, "JPY")).toBe("1500");
    expect(parseMajorToMinor(minorToMajorInput(123456, "EUR"), "EUR")).toBe(123456);
  });
});
