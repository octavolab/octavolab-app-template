# ADR 0005: Per-integration modes and the ALLOW_LIVE gate
Date: 2026-10-22 · Status: accepted · Amends: ADR 0003

## Context
ADR 0003 selected every adapter with one global `INTEGRATIONS_MODE`. Staging needs real providers in test mode (Stripe test
keys, Resend to a team inbox) while other integrations have no sandbox yet (the OES API specification is pending), so
`INTEGRATIONS_MODE=sandbox` would have broken carrier quotes at the first request. A misconfiguration was also only found
at the first request, and nothing technical stopped a live key from being used on staging.

## Decision
1. Four modes, each `fake | sandbox | live`: `PAYMENTS_MODE`, `MESSAGING_MODE`, `CARRIER_MODE`, `STORAGE_MODE`. Each defaults
   to `INTEGRATIONS_MODE` (so existing deployments behave exactly as before), then to `fake` outside production. In
   `NODE_ENV=production` every mode must resolve explicitly.
2. One validator, `validateIntegrationEnv` in `packages/integrations/src/config.ts`, used by the API env schema (API and
   worker exit at boot listing every invalid variable) and again by the adapter factories. Rules: a non-fake mode needs an
   implemented provider and its secrets in the format of the mode (`STRIPE_SECRET_KEY` `sk_test_`/`rk_test_` in sandbox,
   `sk_live_`/`rk_live_` in live); `live` needs `ALLOW_LIVE=true`; `ALLOW_LIVE=true` is accepted only with
   `APP_ENV=production`. Messages name the variable, never the value.
3. `APP_ENV` (`staging | production`) is set by `infra/deploy.sh` from its argument. It names the Sentry environment and
   enables staging defaults (`MESSAGING_FROM`). `ALLOW_LIVE` is never set by code or CI: Jaime sets it in the production
   Lightsail environment after approving live mode (N07).

## Consequences
- Staging can run real Stripe and Resend in test mode with fake carrier and storage, and switch each one when ready.
- A wrong key, a missing secret or an unapproved `live` is a failed deployment (deploy.sh waits for ACTIVE and prints the
  container log), never a broken request in front of a user.
- A deployment that set `INTEGRATIONS_MODE=sandbox|live` without a real provider for every integration now fails at boot
  instead of failing at the first call; set the per-integration modes explicitly (see `docs/integrations/README.md`).
