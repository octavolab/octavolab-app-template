import { describe, expect, it } from "vitest";
import es from "./es.json";
import en from "./en.json";
import { interpolate } from "./index";

describe("i18n dictionaries", () => {
  it("es and en have exactly the same keys and no empty strings", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const d of [es, en]) for (const [k, v] of Object.entries(d)) expect(v.trim(), k).not.toBe("");
  });
  it("es and en use the same placeholders for every key", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const k of Object.keys(en) as (keyof typeof en)[]) expect(ph(es[k]), k).toBe(ph(en[k]));
  });
  it("interpolates placeholders", () => {
    expect(interpolate("Pay {amount}", { amount: "£15.00" })).toBe("Pay £15.00");
    expect(interpolate("{missing}", {})).toBe("{missing}");
  });
});
