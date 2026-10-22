# Stripe (payments)
- Purpose: payment intents for order checkout (hosted fields / Payment Element; the server never sees card data, PCI SAQ A),
  refunds, and the signed webhook that marks orders paid. Adapter: `packages/integrations/src/stripe.ts` (`StripeGateway`).
- Official docs (URL, date read): https://docs.stripe.com/api (payment intents, refunds, balance, idempotent requests,
  errors), https://docs.stripe.com/webhooks (signatures), read 2026-10-22. Re-read on the day keys change (N02).
- Auth and rate limits: `Authorization: Bearer <STRIPE_SECRET_KEY>`. A restricted key (`rk_test_` / `rk_live_`) is preferred,
  with write access to PaymentIntents and Refunds and read access to Balance (health probe). Stripe limits are well above
  this app's volume; a 429 is retried with backoff.
- Sandbox: Stripe Dashboard in **test mode** → Developers → API keys. `PAYMENTS_MODE=sandbox` refuses any key that is not
  `sk_test_` / `rk_test_`. Test cards: https://docs.stripe.com/testing (for example `4242 4242 4242 4242`, any future date, any CVC).
- Live mode checklist: Jaime's approval (N07) · `PAYMENTS_MODE=live`, `ALLOW_LIVE=true`, `APP_ENV=production` · live
  restricted key and live webhook secret in the production Lightsail environment (app and worker) · live webhook endpoint
  created as below · one real low-value payment and refund recorded in `docs/learnings.md`.
- Owner: tech lead in `OWNERSHIP.md`.

## Behaviour (audited 2026-10-22)
| Requirement | Where |
|---|---|
| Idempotency key on every mutating call | `call()` refuses a POST without one (`idempotency_key_required`); checkout uses `checkout:<orderId>`, refunds take the caller's key; retries reuse it |
| Webhook signature | HMAC-SHA256 of `<t>.<raw body>` with `STRIPE_WEBHOOK_SECRET`, constant-time compare, several `v1` (secret roll), 5-minute tolerance |
| Livemode check | an event whose `livemode` differs from `PAYMENTS_MODE` is rejected |
| Replay-safe | `POST /api/v1/webhooks/payments` stores the event id in `WebhookEvent` (unique) in the same transaction as the order change, audit and outbox; a duplicate is acknowledged with no effect |
| Minor units, explicit currency | amounts must be positive safe integers, currency ISO 4217 upper case (sent lower case); checked before any call |
| Timeouts and retries | 10 s per attempt, up to 3 attempts with full jitter on network errors, timeouts, 429 and 5xx; never when Stripe answers `Stripe-Should-Retry: false` |
| Errors | `PaymentError` `stripe <resource> <status> <code>`; never the key or Stripe's free text. The API answers 503 `PROVIDER_ERROR` (retryable) or 502 |
| Health | `GET /api/health` → `deps.payments: ok | degraded` from `GET /v1/balance` (3 s timeout), cached 60 s per process; the health answer waits at most 1 s for it (then `degraded`, the probe finishes in the background); degraded never fails the probe |

## Webhooks
- Endpoint URL: `<STAGING_URL>/api/v1/webhooks/payments` on staging (the GitHub variable `STAGING_URL`, for example
  `https://octavolab-staging.<id>.eu-west-2.cs.amazonlightsail.com/api/v1/webhooks/payments`), `<PROD_URL>/api/v1/webhooks/payments`
  in production.
- Create it in the Dashboard (test mode for staging) → Developers → Webhooks → Add endpoint, API version: the account default.
- Events to subscribe: **`payment_intent.succeeded`** only. It is the only event with an effect (order → `paid` after checking
  status, `amount_received`, `amount`, currency and the intent id stored at checkout). Any other event type is acknowledged and
  ignored, so subscribing to more only adds traffic. Refund and dispute events are roadmap.
- Copy the endpoint's signing secret (`whsec_...`) to `STRIPE_WEBHOOK_SECRET`. Each endpoint (test and live) has its own.
- Test: `stripe trigger payment_intent.succeeded` hits the endpoint but has no `metadata.orderId`, so it is recorded and
  ignored; the end-to-end check is a checkout on staging paid with a test card.

## Key rotation
1. Create the new restricted key (or roll the webhook secret: Stripe keeps the old one valid for the overlap you choose).
2. Update `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` in the Lightsail environment of the ACTIVE deployment (app; deploy.sh
   copies it to the worker) and redeploy.
3. Check `/api/health` shows `deps.payments: "ok"`, then revoke the old key.
