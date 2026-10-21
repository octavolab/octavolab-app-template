# Changelog
All notable changes to this project are documented here (Keep a Changelog, semver).

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
  login limit keyed by email + IP (no lockout DoS) (unit).
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
