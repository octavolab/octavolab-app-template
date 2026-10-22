import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OesCarrier, mapOesError, fromOesResponse, toOesRequest, OES_MAX_TIMEOUT_MS } from "./oes.js";
import { CarrierError } from "./contracts.js";
import { CircuitBreaker } from "./resilience.js";

const KEY = "oes_test_key_xxx";
const BASE = "https://oes.example.invalid/api";
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/oes");
type Fixture = { request: { from: string; to: string; weightKg: number; volumetricKg: number }; wireRequest?: unknown; status: number; response: unknown; expected?: unknown; expectedError?: { code: string; retryable: boolean; message: string } };
const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => [f, JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as Fixture] as const);

function replay(...answers: ({ status: number; body?: unknown } | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const a = answers.shift() ?? { status: 500, body: {} };
    if (a instanceof Error) throw a;
    return new Response(a.body === undefined ? "not json" : JSON.stringify(a.body), { status: a.status });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}
const carrier = (f: ReturnType<typeof replay>, extra: Partial<ConstructorParameters<typeof OesCarrier>[0]> = {}) =>
  new OesCarrier({ baseUrl: BASE, apiKey: KEY, quotePath: "/quotes", fetchImpl: f.impl, sleep: async () => {}, ...extra });
const input = { from: "GB", to: "CO", weightKg: 1, volumetricKg: 1 };

describe("OES contract (recorded fixtures, no network)", () => {
  it.each(fixtures)("%s", async (_name, fx) => {
    const f = replay({ status: fx.status, body: fx.response }, { status: fx.status, body: fx.response }, { status: fx.status, body: fx.response });
    const result = carrier(f).quote(fx.request);
    if (fx.expectedError) {
      await expect(result).rejects.toMatchObject(fx.expectedError);
    } else {
      expect(await result).toEqual(fx.expected);
    }
    const call = f.calls[0]!;
    expect([call.url, call.init.method]).toEqual([`${BASE}/quotes`, "POST"]);
    if (fx.wireRequest) expect(JSON.parse(String(call.init.body))).toEqual(fx.wireRequest);
    const h = call.init.headers as Record<string, string>;
    expect([h.Authorization, h["Content-Type"]]).toEqual([`Bearer ${KEY}`, "application/json"]);
  });
});

describe("OesCarrier transport", () => {
  it("retries 5xx and 429 only, with jitter, and succeeds on a later attempt", async () => {
    const f = replay({ status: 503, body: {} }, { status: 429, body: {} }, { status: 200, body: { rates: [] } });
    expect(await carrier(f).quote(input)).toEqual([]);
    expect(f.calls.length).toBe(3);
  });

  it("never retries 4xx, network errors or timeouts", async () => {
    for (const answer of [{ status: 400, body: { code: "bad_request" } }, { status: 401, body: {} }, new TypeError("ECONNRESET")]) {
      const f = replay(answer, { status: 200, body: { rates: [] } });
      await expect(carrier(f).quote(input)).rejects.toBeInstanceOf(CarrierError);
      expect(f.calls.length).toBe(1);
    }
  });

  it("caps the timeout at 8 s and shares one budget across attempts", async () => {
    expect(OES_MAX_TIMEOUT_MS).toBe(8000);
    const slow = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
    })) as unknown as typeof fetch;
    const err = await new OesCarrier({ baseUrl: BASE, apiKey: KEY, quotePath: "/quotes", fetchImpl: slow, timeoutMs: 15 }).quote(input).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "timeout", retryable: true, message: "oes timeout after 15 ms" });
    expect((new OesCarrier({ baseUrl: BASE, apiKey: KEY, quotePath: "/q", timeoutMs: 60_000 }) as unknown as { timeoutMs: number }).timeoutMs).toBe(8000);
    // A 5xx whose backoff would end after the deadline is not retried.
    let now = 0;
    const f = replay({ status: 500, body: {} }, { status: 200, body: { rates: [] } });
    const late = carrier(f, { timeoutMs: 100, now: () => now, fetchImpl: (async (...a: Parameters<typeof fetch>) => { now += 99; return f.impl(...a); }) as typeof fetch });
    await expect(late.quote(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(f.calls.length).toBe(1);
  });

  it("opens the circuit after consecutive provider failures and fails fast; a 4xx does not count", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });
    const f = replay({ status: 400, body: {} }, { status: 500 }, { status: 500 }, { status: 500 }, new TypeError("down"), { status: 200, body: { rates: [] } });
    const c = carrier(f, { breaker, attempts: 3 });
    await expect(c.quote(input)).rejects.toMatchObject({ code: "rejected" });
    await expect(c.quote(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(c.quote(input)).rejects.toMatchObject({ code: "network" });
    const before = f.calls.length;
    await expect(c.quote(input)).rejects.toMatchObject({ code: "circuit_open", retryable: true, message: "oes circuit open" });
    expect(f.calls.length).toBe(before);
    now = 1000;
    expect(await c.quote(input)).toEqual([]);
    expect(breaker.state).toBe("closed");
  });

  it("rejects invalid input before calling, and malformed responses as bad_response", async () => {
    const f = replay({ status: 200, body: { rates: [{ carrier: "A", service: "S", amount: 1.5, currency: "GBP" }] } }, { status: 200, body: { nope: 1 } }, { status: 200 });
    await expect(carrier(f).quote({ ...input, weightKg: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.calls.length).toBe(0);
    for (let i = 0; i < 3; i++) await expect(carrier(f).quote(input)).rejects.toMatchObject({ code: "bad_response", retryable: false });
  });

  it("never puts the key or the provider's free text in an error", async () => {
    const err = (await carrier(replay({ status: 422, body: { code: `leak ${KEY}`, message: KEY } })).quote(input).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("oes 422 error");
    expect(String(err.stack)).not.toContain(KEY);
  });

  it("reads OES_API_URL, OES_API_KEY and OES_QUOTE_PATH from the environment and refuses to build without them or without https", () => {
    const prev = { ...process.env };
    try {
      for (const k of ["OES_API_URL", "OES_API_KEY", "OES_QUOTE_PATH"]) delete process.env[k];
      expect(() => new OesCarrier()).toThrow("OES_API_URL missing");
      process.env.OES_API_URL = "http://oes.example.invalid";
      expect(() => new OesCarrier()).toThrow("OES_API_KEY missing");
      process.env.OES_API_KEY = KEY;
      expect(() => new OesCarrier()).toThrow("OES_QUOTE_PATH missing");
      process.env.OES_QUOTE_PATH = "/quotes";
      expect(() => new OesCarrier()).toThrow("must be https");
      process.env.OES_API_URL = `${BASE}/`;
      expect(new OesCarrier().name).toBe("oes");
    } finally {
      process.env = prev;
    }
  });
});

describe("OES mapping", () => {
  it("mapOesError classifies statuses and only lets a lower-case code through", () => {
    const c = (s: number, code = "") => { const e = mapOesError(s, code); return [e.code, e.retryable]; };
    expect([c(429), c(500), c(401), c(403), c(404), c(422)]).toEqual([["rate_limited", true], ["provider_unavailable", true], ["auth", false], ["auth", false], ["rejected", false], ["rejected", false]]);
    expect(mapOesError(400, "<x>").message).toBe("oes 400 error");
  });
  it("provisional wire format round-trips our contract", () => {
    expect(toOesRequest(input)).toEqual({ origin: "GB", destination: "CO", weightKg: 1, volumetricKg: 1 });
    expect(fromOesResponse({ rates: [{ carrier: "A".repeat(100), service: "S", amount: 0, currency: "EUR", etaDays: -1 }] })).toEqual([{ carrier: "A".repeat(80), service: "S", money: { amount: 0, currency: "EUR" } }]);
    expect(() => fromOesResponse(null)).toThrow("oes response without rates");
  });
});
