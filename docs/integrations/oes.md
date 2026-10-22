# OES — One Easy Stop (carrier rates)
- Purpose: carrier rate quotes (`CarrierRates.quote`). Adapter: `packages/integrations/src/oes.ts` (`OesCarrier`).
- Official docs (URL, date read): **not available yet**. The OES API specification is not in this repository and was not
  provided; no endpoint, header or field name in the adapter comes from OES (see TODO below).
- Auth and rate limits: `OES_API_KEY`, sent as `Authorization: Bearer` (ASSUMED, to confirm). Rate limits unknown; 429 is retried.
- Sandbox: base URL and keys to be provided by OES. Staging keeps `CARRIER_MODE=fake` until then.
- Webhooks: none expected for quotes.
- Live mode checklist: spec implemented and fixtures re-recorded · Jaime's approval (N07) · `CARRIER_MODE=live`,
  `ALLOW_LIVE=true` · live URL and key in Lightsail · first real quote compared with the OES portal and recorded in `docs/learnings.md`.
- Key rotation: new key from OES → update `OES_API_KEY` in Lightsail → redeploy → revoke the old key.
- Owner: tech lead in `OWNERSHIP.md`.

## Configuration
| Variable | Meaning |
|---|---|
| `CARRIER_MODE` | `fake` (default from `INTEGRATIONS_MODE`) · `sandbox` · `live` |
| `CARRIER_PROVIDER` | `oes` when the mode is not fake |
| `OES_API_URL` | https base URL; the sandbox URL on staging, the live URL in production |
| `OES_API_KEY` | API key for that environment |
| `OES_QUOTE_PATH` | quote endpoint path from the OES spec (configuration, not invented in code) |

## Behaviour (independent of the wire format)
- One time budget per quote: 8 s maximum, shared by every attempt (`OES_MAX_TIMEOUT_MS`).
- Retries: up to 3 attempts, full-jitter backoff, on **5xx and 429 only** (never on 4xx, network errors or timeouts), and never
  past the budget.
- Circuit breaker: 5 consecutive provider failures (5xx, 429, timeout, network) open it for 30 s; calls fail fast with
  `CarrierError` `circuit_open` (retryable); one probe call then decides. A 4xx proves OES is up and resets it.
- Errors: `CarrierError` `oes <status> <code>` with `code` `rate_limited | provider_unavailable | auth | rejected | timeout |
  network | bad_response | invalid_input | circuit_open`; never the key or OES free text. The API maps them to 503/502.

## TODO(OES-SPEC): exact information needed from OES
1. Base URLs for sandbox and live; quote endpoint HTTP method and path (POST assumed).
2. Authentication: header name and scheme, key format, whether sandbox and live keys differ, rotation.
3. Request fields: origin/destination format (ISO 3166 country, postcode, full address?), weight unit, dimensions vs volumetric
   weight and the divisor OES applies, package count, declared value and currency, service filter, account id if any.
4. Response fields: path of the rate list; per rate the carrier, service name/code, price (decimal or minor units), currency,
   transit days, quote id and expiry.
5. Error format: status codes, the machine-readable error code field, rate limits and `Retry-After`.
6. Sandbox test data: lanes or postcodes with deterministic rates.

When it arrives: rewrite `toOesRequest` / `fromOesResponse` (marked PROVISIONAL), replace the synthetic fixtures in
`packages/integrations/test/fixtures/oes/` with recorded sandbox responses (no account ids or personal data), and run the
opt-in test once:

```bash
OES_SANDBOX_TEST=1 OES_API_URL=<sandbox url> OES_API_KEY=<sandbox key> OES_QUOTE_PATH=<path> \
  pnpm --filter @octavolab/integrations exec vitest run src/oes.sandbox.test.ts
```

## Verified
- Locally and in CI: contract tests replaying the fixtures (`src/oes.test.ts`, no network), retries, budget, circuit breaker,
  error mapping, env validation.
- Not verified: anything against the real OES API (no spec, no sandbox access).
