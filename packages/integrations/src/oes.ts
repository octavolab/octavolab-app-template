import type { CarrierQuote, CarrierQuoteInput, CarrierRates } from "./contracts.js";
import { CarrierError } from "./contracts.js";
import { CircuitBreaker, retryWithJitter, type Sleep } from "./resilience.js";

/**
 * OES (One Easy Stop) carrier rates adapter, implements CarrierRates.
 *
 * ┌─ TODO(OES-SPEC) ───────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ The OES API specification is NOT in this repository, so no endpoint, header or field below is taken from OES.    │
 * │ The transport (timeouts, retries, circuit breaker, error mapping) is complete; the WIRE FORMAT is provisional:   │
 * │ `toOesRequest` / `fromOesResponse` mirror our own CarrierRates contract and must be rewritten against the spec.  │
 * │ Exact information needed from OES (also listed in docs/integrations/oes.md):                                     │
 * │  1. Base URLs for sandbox and live (-> OES_API_URL per environment) and the quote endpoint method + path         │
 * │     (-> OES_QUOTE_PATH; POST is assumed).                                                                        │
 * │  2. Authentication: header name and scheme (`Authorization: Bearer <OES_API_KEY>` is assumed), key format,       │
 * │     whether sandbox and live keys differ, rotation procedure.                                                    │
 * │  3. Request fields: origin and destination format (ISO 3166 country? postcode? full address?), weight unit,      │
 * │     dimensions vs volumetric weight (and the divisor OES applies), package count, declared value + currency,     │
 * │     service-level filter, account/customer id if any.                                                            │
 * │  4. Response fields: path of the rate list; per rate the carrier name, service name/code, price (decimal or      │
 * │     minor units?), currency, transit days, quote id and quote expiry.                                            │
 * │  5. Error format: status codes, the machine-readable error code field, rate limits and Retry-After semantics.    │
 * │  6. Test data: sandbox lanes/postcodes that return deterministic rates (for the opt-in sandbox test).            │
 * │ Until this is resolved, staging keeps CARRIER_MODE=fake.                                                         │
 * └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Behaviour (independent of the wire format):
 * - One overall time budget per quote (default and maximum 8 s) shared by every attempt.
 * - Up to 3 attempts with full-jitter backoff, on 5xx and 429 only (never on 4xx, network errors or timeouts).
 * - Circuit breaker: 5 consecutive provider failures open it for 30 s; calls then fail fast with `circuit_open`.
 * - Errors are CarrierError with a sanitized message (`oes <status> <code>`): never the key or the provider's free text.
 */
export const OES_MAX_TIMEOUT_MS = 8_000;

export type OesOptions = {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  quotePath?: string | undefined;
  timeoutMs?: number | undefined;
  attempts?: number | undefined;
  breaker?: CircuitBreaker | undefined;
  fetchImpl?: typeof fetch | undefined;
  sleep?: Sleep | undefined;
  now?: (() => number) | undefined;
};

/** PROVISIONAL request body (TODO(OES-SPEC) item 3). */
export function toOesRequest(i: CarrierQuoteInput): Record<string, unknown> {
  return { origin: i.from, destination: i.to, weightKg: i.weightKg, volumetricKg: i.volumetricKg };
}

/** PROVISIONAL response parsing (TODO(OES-SPEC) item 4): `{ rates: [{ carrier, service, amount, currency, etaDays? }] }`, amount in minor units. */
export function fromOesResponse(body: unknown): CarrierQuote[] {
  const rates = (body as { rates?: unknown } | null)?.rates;
  if (!Array.isArray(rates)) throw new CarrierError("oes response without rates", "bad_response", false);
  return rates.map((r: unknown) => {
    const x = r as { carrier?: unknown; service?: unknown; amount?: unknown; currency?: unknown; etaDays?: unknown };
    if (typeof x.carrier !== "string" || typeof x.service !== "string" || !Number.isSafeInteger(x.amount) || (x.amount as number) < 0
      || typeof x.currency !== "string" || !/^[A-Z]{3}$/.test(x.currency)) {
      throw new CarrierError("oes response with an invalid rate", "bad_response", false);
    }
    const q: CarrierQuote = { carrier: x.carrier.slice(0, 80), service: x.service.slice(0, 80), money: { amount: x.amount as number, currency: x.currency } };
    if (Number.isInteger(x.etaDays) && (x.etaDays as number) >= 0) q.etaDays = x.etaDays as number;
    return q;
  });
}

export class OesCarrier implements CarrierRates {
  readonly name = "oes";
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep | undefined;
  private readonly now: () => number;

  constructor(opts: OesOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.OES_API_URL;
    const apiKey = opts.apiKey ?? process.env.OES_API_KEY;
    const quotePath = opts.quotePath ?? process.env.OES_QUOTE_PATH;
    if (!baseUrl) throw new Error("OES_API_URL missing");
    if (!apiKey) throw new Error("OES_API_KEY missing");
    if (!quotePath) throw new Error("OES_QUOTE_PATH missing");
    // Joined, not resolved: a base URL with a path prefix (https://host/api) keeps it for a quote path like /quotes.
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${quotePath.replace(/^\/+/, "")}`);
    if (url.protocol !== "https:") throw new Error("OES_API_URL must be https");
    this.url = url.toString();
    this.apiKey = apiKey;
    this.timeoutMs = Math.min(opts.timeoutMs ?? OES_MAX_TIMEOUT_MS, OES_MAX_TIMEOUT_MS);
    this.attempts = opts.attempts ?? 3;
    this.now = opts.now ?? Date.now;
    this.breaker = opts.breaker ?? new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000, now: this.now });
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
    this.sleep = opts.sleep;
  }

  async quote(input: CarrierQuoteInput): Promise<CarrierQuote[]> {
    if (!(input.weightKg > 0) || !(input.volumetricKg >= 0) || !input.from || !input.to) throw new CarrierError("oes invalid quote input", "invalid_input", false);
    if (!this.breaker.tryAcquire()) throw new CarrierError("oes circuit open", "circuit_open", true);
    const deadline = this.now() + this.timeoutMs;
    try {
      const quotes = await retryWithJitter(() => this.attempt(input, deadline), {
        attempts: this.attempts, baseMs: 200, maxMs: 1_500, deadline, sleep: this.sleep, now: this.now,
        isRetryable: (e) => e instanceof CarrierError && (e.code === "provider_unavailable" || e.code === "rate_limited"),
      });
      this.breaker.onSuccess();
      return quotes;
    } catch (e) {
      // Provider health failures open the circuit; a request OES answered and rejected (4xx, bad input) does not.
      if (e instanceof CarrierError && ["provider_unavailable", "rate_limited", "timeout", "network"].includes(e.code)) this.breaker.onFailure();
      else this.breaker.onSuccess();
      throw e;
    }
  }

  private async attempt(input: CarrierQuoteInput, deadline: number): Promise<CarrierQuote[]> {
    const budget = Math.max(1, deadline - this.now());
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        // TODO(OES-SPEC) item 2: header name and scheme.
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "octavolab-app-template" },
        body: JSON.stringify(toOesRequest(input)),
        signal: AbortSignal.timeout(budget),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new CarrierError(timedOut ? `oes timeout after ${this.timeoutMs} ms` : "oes network error", timedOut ? "timeout" : "network", true);
    }
    const payload = (await res.json().catch(() => undefined)) as { code?: unknown; error?: unknown } | undefined;
    if (res.ok) return fromOesResponse(payload);
    // TODO(OES-SPEC) item 5: the field that carries the machine-readable error code.
    const code = typeof payload?.code === "string" ? payload.code : typeof payload?.error === "string" ? payload.error : "";
    throw mapOesError(res.status, code);
  }
}

/** Provider status + error code -> sanitized, classified CarrierError. Only a whitelisted code shape reaches the message. */
export function mapOesError(status: number, providerCode: string): CarrierError {
  const code = /^[a-z_]{1,48}$/.test(providerCode) ? providerCode : "error";
  const msg = `oes ${status} ${code}`;
  if (status === 429) return new CarrierError(msg, "rate_limited", true, status);
  if (status >= 500) return new CarrierError(msg, "provider_unavailable", true, status);
  if (status === 401 || status === 403) return new CarrierError(msg, "auth", false, status);
  return new CarrierError(msg, "rejected", false, status);
}
