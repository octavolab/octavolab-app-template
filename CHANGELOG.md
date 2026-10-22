# Changelog
All notable changes to this project are documented here (Keep a Changelog, semver).

## [0.7.5] - 2026-10-22
Production readiness (SECURITY.md accepted items).
### Added
- Alerts in the worker every 60 s: `mfa_failed_spike` (MFA_FAILED_ALERT_THRESHOLD failed codes in 15 min, default 10) and `outbox_dead_letter`, posted to `ALERT_WEBHOOK_URL` (https; required when `INTEGRATIONS_MODE=live`) with a one-hour cooldown per rule; never through the outbox (unit).
- Migration `20261022120000_alert_indexes` (expand only): `AuditLog(action, createdAt)` and `Outbox(deadLetteredAt)`.
- ADR 0005: migrations stay at app container start on Lightsail (no network path from CI to a private database, no one-shot tasks); `validate:sql` now fails when a migration's `ROLLBACK.md` does not declare "Expand only", "Contract step" or "Initial migration".
- Runbook: step-by-step restore test with measured recovery time; snapshot before every production deploy; "Alerts" section.
### Changed
- `REQUIRE_PRIVILEGED_2FA=true` now also forces the `operations` role to enroll and keep 2FA (it reads every order of the tenant) (unit).
### Moved here from the 0.7.4 notes
- `WriteOnlyProjectTaggedResources` also requires `aws:ResourceTag/env = ${ENV_NAME}`: the staging role can no longer deploy to production resources (tag existing staging resources `env=staging` before applying).
- `quality` job `timeout-minutes: 30` (the E2E step hung once on 22 Oct 2026).
### Fixed after the independent reviews (same release)
- Production gate in AWS: the prod role trusts only an OIDC subject customized with `repo`, `context`, `ref` and `actor_id` (environment `production`, a `v*` tag and the approver's numeric id); residual risk documented; the workflow `if` (now also `github.triggering_actor`) is defense in depth (infra/README "Production gate"). `deploy-prod` gets `timeout-minutes: 45` and a concurrency group; `deploy.sh prod` snapshots the database after the image push and waits until the snapshot is `available` before deploying (fails closed); the deploy policy gains `GetRelationalDatabaseSnapshot`.
- Alerts: the cooldown starts only after a successful delivery; dead letters are counted since the evaluation time of the last delivered alert.
- `deploy.sh`: `umask 077` and an EXIT trap from the first line, so no temp file with secrets is world-readable or left behind.
- Runbook: 0.7.5 rollout note for operations users; restore test re-runs the deploy job instead of pushing to `main`.
- SECURITY.md: the signed sign-off table is restored as signed; changes go to "Amendment 1", pending Jaime's re-sign.
- Docs: `env=prod` tag for production resources; negative IAM test; ADR 0005 lock note; restore test with `INTEGRATIONS_MODE=fake`; Slack is the webhook format known to work.
### Not done (stays open)
- Node 24: the `node:24-alpine` digest could not be resolved from the build session (no registry access); Dependabot (docker) proposes it after its cooldown. Node 22 is in maintenance until April 2027.
- Restore test: procedure written; it runs in Jaime's AWS session with a temporary paid database.
- Passkeys (WebAuthn).

## [0.7.4] - 2026-10-22

### Security
- `ProjectSecrets` in `infra/iam-policy-project.json` is scoped per environment (`${PROJECT_NAME}/${ENV_NAME}-*`): the staging deploy role can no longer read `<project>/prod`. One policy per environment (`infra/README.md`). The live AWS policy must be updated by Jaime before the production secret exists (N07).

### Docs
- `CLAUDE.md` points to kit `octavolab-core@7.4.0`.
- LOGBOOK: smoke failure of run 39784069128 recorded (fixed by 573d10c) and the independent audit result.

## [0.7.3] - 2026-10-22

### Final audit follow-ups (48/50 with Cumplimiento at 4)
- Recovery codes: 23 symbols, 115 bits each (`XXXXX-XXXXX-XXXXX-XXXXX-XXX`), above the 112 bits of ASVS 2.6.2; older 50-bit codes stay valid until regenerated (unit).
- Secrets: `infra/deploy.sh` merges the AWS Secrets Manager secret `<PROJECT_NAME>/<env>` into the app container (the worker inherits it); the deploy policy can read only that project's secrets. ASVS 6.4.1 stays Partial until the secret exists and a deploy log shows the merge.
- The E2E comment uses the new variable name.
- ASVS 6.4.1 Met for staging: the secret exists and every deploy merges it (CI notice, run 39786567499).
- Staging secret seeded automatically (once) from the active Lightsail environment when the deploy role has `ProjectSecrets` (`GetSecretValue`, `DescribeSecret`, `CreateSecret`, `TagResource` on `<PROJECT_NAME>/*` only); values never printed; never in production.
- `deploy.sh` reads secrets fail-closed: production stops on any Secrets Manager error; outside production only a missing secret or a role without `ReadProjectSecrets` falls back, with a CI warning.
- ASVS L2 checklist signed by Jaime Blum (CTO) on 2026-10-22, with the open items accepted before production listed in `SECURITY.md`.
- Deploys: one staging deploy at a time (`concurrency`), `deploy.sh` waits while Lightsail is deploying and until the new deployment is RUNNING, and the smoke test checks the deployed version. A real run (39776447566) failed because two pushes deployed at once. The smoke checks also failed open (`grep && echo` under `set -e`); they now exit 1.
- First-access bootstrap: with `BOOTSTRAP_OWNER_EMAIL` and `BOOTSTRAP_OWNER_PASSWORD` set, the API creates the demo tenant, demo products and the first owner at start; idempotent, never overwrites a user, never logs the password (unit). Runbook: "First access".

## [0.7.2] - 2026-10-22

### Independent re-audit (44/50) follow-ups
- Supply chain: base and service images pinned by digest (`node:22-alpine`, `postgres:16-alpine`, `redis:7-alpine`, `semgrep/semgrep`); `lightsailctl` installed with `go install ...@v1.0.8` (version pinned, verified by the Go checksum database) instead of an unpinned `latest` download inside the jobs that hold AWS credentials.
- CI boots the real image against PostgreSQL (`migrate deploy`, server start, `/api/health` ok, and no npm or build tools in the runtime image) before trivy.
- Real web UI (apps/web), ES/EN, 390 to 1440 px, axe-checked: sign-in with 2FA step, catalog, cart, checkout (Idempotency-Key reused per cart; Stripe Elements only with a real client secret and publishable key, otherwise a labelled demo state with no card fields), "My orders" with cursor paging; staff 2FA enrollment (inline SVG QR, recovery codes shown once) and product management. Playwright E2E for both flows at 4 widths.
- Seed creates `customer@example.com` only when `SEED_CUSTOMER_PASSWORD` is set; CI seeds with random per-run passwords and a per-run `TOTP_ENC_KEY`.
- CSP allows only what Stripe Elements needs (`js.stripe.com`, `hooks.stripe.com`, `api.stripe.com`); `/auth/me` returns the email (unit).
- Staging is live on Lightsail, deployed by CI through the OIDC role (no keys); smoke test passes.
- `REQUIRE_OWNER_2FA` renamed `REQUIRE_PRIVILEGED_2FA` (it covers owners and admins); the old name is still accepted and the new one wins (unit). Route description and OpenAPI say "owners and admins".

## [0.7.1] - 2026-10-22

### Fixed after the first real CI run (run 39741290733)
- Every GitHub Action is pinned to a full commit SHA with the tag as a comment (semgrep `github-actions-mutable-action-tag`); `aquasecurity/trivy-action@0.28.0` no longer resolves and moves to v0.36.0.
- pnpm 10.34.7 (`packageManager`); `pnpm/action-setup` reads it, so the conflicting `version: 9` input is gone.
- Supply-chain settings in `pnpm-workspace.yaml`: `minimumReleaseAge: 10080`, `trustPolicy: no-downgrade`, `blockExoticSubdeps: true`, and `onlyBuiltDependencies` for the reviewed packages with install scripts (Prisma, argon2, esbuild, msgpackr-extract).
- AES-256-GCM: the authentication tag length is fixed at 16 bytes on both sides and a truncated tag is rejected before decryption (semgrep `gcm-no-tag-length`; unit).
- `schema.prisma` used one-line blocks that Prisma rejects (`prisma generate` failed on the first real run; local tests used the in-memory stand-in, so this was only visible in CI). Blocks rewritten one field per line; `prisma validate` passes.
- A test called `$transaction` with a `never`-typed callback that only compiled without a generated client; fixed.
- Dependabot waits 7 days before proposing a new release (`cooldown`), matching `minimumReleaseAge`.
- Dependencies with advisories (osv-scanner, `pnpm audit`): `@fastify/static` 8.3 to 10.1.6 (runtime), vite 5.4 to 6.4.4, vitest 2.1 to 4.1.12, `@vitejs/plugin-react` 4 to 5.2. `pnpm audit`: no known vulnerabilities. rollup is pinned by override to a release older than 7 days; vitest is a dated, dev-only exception to `minimumReleaseAge` (remove after 2026-10-23); `semver@6.3.1` is excluded from `trustPolicy` (old release published before provenance).
- vitest 4 no longer excludes `dist/` by default: compiled tests ran twice. `dist/**` is excluded explicitly.
- vitest 4 measures branches more strictly (82.4 % against the 85 % ratchet). The threshold was NOT lowered: new tests cover the Redis store of the login and 2FA limiters (shared counters, aborted transaction, expiry, the 50,000-key fail-closed bound) and the health probe (Redis ok, odd reply, error; database down). Branches now 85.8 %, lines 97.9 %.
- Runtime image: production dependencies only (fresh `pnpm install --prod --offline` after the build). trivy found a Go stdlib CRITICAL in the esbuild binary, a build tool that was shipping in the image; `prisma` moves to `dependencies` of packages/db because the container runs `migrate deploy`.
- Runtime image: npm, npx and corepack from the base image are removed (trivy found 10 HIGH advisories in npm's bundled dependencies; the app never runs them).
- `.gitleaksignore` lists two reviewed false positives by fingerprint: the RFC 6238 test seed and a fake Resend key in tests.

## [0.7.0] - 2026-10-22

### Security follow-ups from the independent re-audit
- 2FA is required for admins as well as owners when `REQUIRE_OWNER_2FA=true` (unit).
- Owner 2FA cannot be reset by another owner from the API; it follows the runbook (unit).
- Demoting a user to customer clears TOTP and recovery codes (unit).
- `/me/orders` rejects a cursor that is not one of the caller's orders (unit).
Independent audit (43/50): the three code gaps closed. "Unit" means it runs locally and in CI against the in-memory Prisma
stand-in; "PG (CI)" means a PostgreSQL integration test that runs only in CI; "real run" means only a real CI run, provider
sandbox or Lightsail deploy can confirm it.

### Added
- Customer self-service checkout (role `customer`): `POST /api/v1/me/orders` (SKUs and quantities only, priced from the tenant
  catalog), `GET /api/v1/me/orders` (cursor pagination), `GET /api/v1/me/orders/:id`, `POST /api/v1/me/orders/:id/checkout`
  (same `startCheckout`, state machine and provider key `checkout:<orderId>` as staff). Owner filter on every read and on
  checkout (`Order.customerUserId`); Idempotency-Key scoped to tenant and customer and bound to the body (unit, including IDOR
  tests; PG (CI)).
- Tenant price list: `Product` model, `GET /api/v1/products`, `PUT /api/v1/products/:sku` (owner, admin; audited) (unit).
- Resend messaging adapter (`MESSAGING_PROVIDER=resend` in sandbox or live mode; fake stays the default): fetch with a 10 s
  timeout, retries left to the outbox, provider idempotency key `outbox:<eventId>`, classified and sanitized errors
  (`MessagingError`), sandbox restricted to Resend's test inbox; `RESEND_API_KEY` and `MESSAGING_FROM` validated at start-up
  only when needed (unit with a mocked fetch; real send: real run). See `docs/integrations/resend.md`.
- TOTP two-factor authentication (RFC 6238) for owner, admin and operations: enroll, activate, second login step
  (`POST /api/v1/auth/login/mfa`), disable, recovery-code regeneration, owner reset of another user's 2FA
  (`POST /api/v1/users/:id/2fa/reset`). Secrets encrypted with AES-256-GCM (`TOTP_ENC_KEY`), 10 single-use recovery codes
  stored as keyed HMAC, single-use codes, rate limits, audit entries, `REQUIRE_OWNER_2FA` (unit; RFC vectors; PG (CI) for the
  concurrent single-use updates).
- Migrations `20261021130000_product_catalog_customer_orders` and `20261021130100_user_totp_2fa` (expand only, each with
  ROLLBACK.md), replayed in order on PGlite (`validate:sql`, 7 migrations).
- Integration test `apps/api/test/integration/self-service-mfa.int.test.ts` (PG (CI)).

### Changed
- Outbox worker: handlers receive the event id; an error with `retryable === false` is dead-lettered at once.
- `requireAuth` exposes the account (`req.account`) and enforces forced enrollment for owners when `REQUIRE_OWNER_2FA=true`.
- `GET /api/v1/auth/me` adds `mfaEnabled` and `mfaEnrollmentRequired`. `POST /api/v1/auth/login` answers
  `{ mfaRequired: true }` (no session) for accounts with 2FA once the password is correct.
- API tests share one in-memory Prisma stand-in (`apps/api/src/test-support/prisma-stand-in.ts`) whose reads return copies,
  like Prisma.
- Coverage ratchet raised (api: lines 95, branches 85, functions 93; 100 % lines on TOTP and secret-box code).
- `infra/lightsail.json` sets `REQUIRE_OWNER_2FA=true` for the app (and, through deploy.sh, the worker).

### Upgrade notes
- Before deploying 0.7.0 to staging or production, add `TOTP_ENC_KEY` (`openssl rand -base64 32`) to the Lightsail environment:
  with `REQUIRE_OWNER_2FA=true` the API refuses to start without it. Owners must enroll at their next sign-in.
- Seed adds two demo products; customers can only order SKUs that exist and are active in their tenant.

### Tests
- 67 -> 129 unit and API tests (`npx vitest run`); api coverage 95.5/82.4/89.1 -> 97.7/87.6/96.0 (lines/branches/functions);
  integration tests 10 -> 15 (CI only).

## [0.6.0] - 2026-10-21
Independent audit (34/50): every defect below fixed. "Unit" means it runs locally and in CI against the in-memory Prisma
stand-in; "PG (CI)" means a PostgreSQL integration test that runs only in CI; "real run" means only a real CI run or
Lightsail deploy can confirm it.

### Added
- `POST /api/v1/orders/:id/checkout`: draft or confirmed -> `pending_payment` through the state machine, payment intent via the
  PaymentGateway adapter (fake in tests, Stripe in sandbox/live), intent id stored on `Order.paymentIntentId`; idempotent; the
  existing webhook moves the order to `paid` (unit; PG (CI) with the fake adapter).
- `PATCH /api/v1/users/:id/role` (owner only, tenant-scoped, audited, revokes the target's sessions) (unit).
- OpenAPI document at `GET /api/openapi.json` (non-production) and committed as `docs/openapi.json`, kept in sync by a test.
- `pnpm --filter @octavolab/db validate:sql`: replays all migrations in order on PGlite (also a CI step).
- Migrations: `20261021120000_user_session_version`, `20261021120100_order_tenant_required_idempotency_hash`,
  `20261021120200_outbox_dead_letter`, `20261021120300_order_checkout_payment_intent` (each with ROLLBACK.md).
- `infra/README.md`: IAM policy, OIDC model and the checklist for the first real run.

### Fixed (high)
- CI: deploy jobs run only on `push` (the nightly schedule no longer redeploys staging); `id-token: write` only in deploy jobs.
- Sessions: logout and role changes revoke sessions server-side (`User.sessionVersion`, `sv` in the token, user re-read on every
  authenticated request; 401 if missing, version, role or tenant changed) (unit).
- Tenancy: no shared NULL tenant; tenant routes return 403 without a tenant; `Order.tenantId` NOT NULL (unit; PG (CI)).
- IAM policy: `lightsail:CreateContainerServiceRegistryLogin` instead of the invalid `PushContainerImage`; write actions require
  `aws:ResourceTag/project` (real run).
- Dockerfile: openssl in both stages, no Corepack at runtime, `prisma migrate deploy` from `packages/db/node_modules/.bin` (real run).

### Fixed (medium)
- README quick start: `.env` loaded by the API (`--env-file`) and the db scripts (dotenv-cli).
- Idempotency-Key bound to the request (`IdempotencyKey.requestHash`, 422 IDEMPOTENCY_MISMATCH) (unit; PG (CI)).
- Outbox: handler per event type, unknown types never delivered, dead-letter at 8 attempts with an error log, recipient from
  `OPS_EMAIL` (unit).
- Webhook transaction: PostgreSQL integration test for duplicate delivery (P2002), amount and currency mismatch and rollback on
  failure (PG (CI)); docs no longer call the in-memory tests "tested" against a database.
- Auth events: `login_failed` logged with an email fingerprint; AuditLog for login and logout (unit).
- Rate limits: Redis store when `REDIS_URL` is set (PG (CI)), memory otherwise (single-instance limitation documented);
  login limits in two windows: 5 per minute per email + IP (an attacker on another IP cannot lock the owner out) and a soft cap of 30 per hour per account across all IPs (stops distributed guessing; recovers by itself, so an attacker can delay that account's logins for up to an hour, the accepted trade-off); both fail closed if Redis is down, while ordinary routes fail open (unit).
- A succeeded payment for an order that is not payable (for example still draft) is audited as `payment_unapplied` instead of being dropped (unit).
- `/api/health` reports `deps.redis` (ok, down, not_configured) (unit).
- Deploy: the worker container inherits the app container's environment (it validates the same variables) (only confirmable in a real Lightsail deploy).
- Production refuses to start without an explicit `INTEGRATIONS_MODE` (unit).
- AWS credentials documented as OIDC role assumption everywhere (deploy.sh, runbook, onboarding, SECURITY.md).

### Fixed (low)
- Stripe signature: digits-only timestamp, several `v1` signatures accepted; webhook requires `status === "succeeded"` and
  `amount_received` equal to the order total (unit).
- Client `x-request-id` accepted only if it matches `^[\w-]{1,64}$` (unit).
- `vite preview` proxies `/api`, and the e2e health check goes through it (real run).
- CI scanners: gitleaks and osv-scanner as CLIs in their images, semgrep in the `semgrep/semgrep` container, trivy
  `ignore-unfixed: true` (real run).

### Tests
- 30 -> 64 unit and API tests (`npx vitest run`); integration tests: 3 -> 10 (CI only).

## [0.5.0] - 2026-10-21
### Fixed (independent review, round 4)
- Webhook event record, amount and currency check, state change, audit and outbox now commit in one transaction (rollback and retry unit-tested against an in-memory stand-in; the PostgreSQL integration test was added in 0.6.0 and runs in CI).
- Payments with a different amount or currency do not mark the order paid; the mismatch is audited (unit-tested against an in-memory stand-in).
- Sessions have a 12-hour absolute lifetime from sign-in even when rotated (tested).

## [0.4.1] - 2026-10-21
### Fixed (independent review, round 4)
- Integration tests were excluded by vitest.config.ts (`test:int` found no files); they now run with INTEGRATION=1.
- Fake payments webhook (unsigned) closed when NODE_ENV=production; proxy trust limited to one hop; login limit per account from any IP (tested with rotating X-Forwarded-For); orders readable by staff roles only.

## [0.4.0] - 2026-10-21
### Added (independent review, round 3)
- Authentication: Argon2id, signed sessions with rotation, `POST /auth/login`, `/auth/logout`, `GET /auth/me`; login rate limit per IP and email; no user enumeration.
- Authorization: role guard and tenant-scoped reads (`GET /orders/:id` returns 404 across tenants); idempotency keys scoped by tenant.
- Payments webhook route with signature check, dedupe and race-safe transition to paid; order state machine.
- Repository layer for users and orders.
- 21 unit and API tests (in-memory Prisma) with coverage 87/82/86 and 100 % on money, session and state logic; integration tests against PostgreSQL in CI.

## [0.3.0] - 2026-10-21
### Fixed (independent review, round 2)
- Initial SQL migration (validated on PostgreSQL via PGlite: 8 tables, indexes, foreign keys) with migration_lock and a rollback plan; CI checks migrations exist.
- Outbox claims rows with FOR UPDATE SKIP LOCKED and lockedUntil (a second worker gets zero rows, verified), exponential backoff, non-overlapping loop.
- /api/health returns 503 when the database is down.
- Order totals guarded against the 32-bit minor-unit column.
- README, ARCHITECTURE, runbook, ADR and PR template describe only what exists; roadmap items labeled (N52).
- IAM policy and CODEOWNERS notes; approvals in CLAUDE.md no longer imply a single grouped approval per session.

## [0.2.0] - 2026-10-21
### Fixed (independent review)
- deploy.sh carries over the ACTIVE deployment environment (Lightsail replaces the whole deployment).
- Stripe webhook signature verification with 300 s tolerance; live mode refuses test keys; tests added.
- Adapter selection throws instead of silently returning fake adapters outside fake mode; test added.
- Validation errors return 4xx with code and requestId; API serves the web build with SPA fallback.
- Node 22 LTS image and CI; .dockerignore; lightsailctl installed in deploy jobs; nightly schedule for ZAP.
- Workspace packages build to dist with a development export condition; coverage thresholds as a ratchet.
- SECURITY.md separates what is implemented from roadmap (N52).

## [0.1.0] - 2026-10-21
### Added
- Template: API (Fastify, zod, Prisma, outbox, audit log, idempotency), web (React, Vite, Tailwind), integrations adapters, CI with security scanners, Lightsail deploy scripts, docs.
