# Security
Report: security@octavolab.com (replace with the group address). Do not open public issues for vulnerabilities.

## Implemented today (template v0.6.0)
How each control is checked is stated next to it:
- **unit**: unit or API test that runs locally and in CI against an in-memory Prisma stand-in (`npx vitest run`).
- **PG (CI)**: integration test against a real PostgreSQL 16 (and Redis) that runs in CI only (`INTEGRATION=1 pnpm --filter api test:int`); written and reviewed, not executed in the authoring environment.
- **real run**: only a real CI run or Lightsail deploy confirms it (see the bottom of this file).

Authentication and sessions
- Argon2id passwords; constant-work login for unknown emails; same error for unknown email and wrong password (unit).
- Signed short-lived session cookie (HMAC-SHA256, httpOnly, Secure in production, SameSite=Strict), rotated after half its life, 12-hour absolute lifetime from sign-in (unit).
- Server-side revocation: the token carries the user's `sessionVersion`; every authenticated request re-reads the user by primary key and rejects the token (401 SESSION_REVOKED) if the user is gone or its session version, role or tenant changed. Logout and role changes increment `sessionVersion`, which ends every session of that user on every device (unit).
- Login rate limit 5/min per (email, client IP): an attacker cannot lock a user out from another IP; global limit `RATE_LIMIT_MAX` (default 100/min) per IP; proxy trust limited to one hop (unit). Counters live in Redis when `REDIS_URL` is set (PG (CI): shared counter across two API instances against the CI Redis). Without `REDIS_URL` they live in process memory: correct only while the service runs a single API instance, because each instance would count separately.
- Security events (ASVS 7.2.1): `login_failed` is logged with a keyed HMAC fingerprint of the email, never the email or the password; request body passwords are redacted; AuditLog rows for `login`, `logout` and `role_change` (unit).

Authorization and tenancy
- Role checks; orders readable by staff roles only (customer self-service is roadmap) (unit).
- No shared tenant: tenant-scoped routes return 403 TENANT_REQUIRED for a user without a tenant; `Order.tenantId` is NOT NULL in the database (unit; NOT NULL enforced: PG (CI)). Another tenant's order returns 404 (unit).
- Role changes: owner-only, inside the owner's tenant, never on oneself (unit).

Data integrity and payments
- Idempotency-Key scoped by tenant and bound to the request: the stored sha256 of the canonical JSON of the operation and input must match, otherwise 422 IDEMPOTENCY_MISMATCH (unit; PG (CI)).
- Checkout (`POST /api/v1/orders/:id/checkout`): staff only, tenant-scoped, idempotent; the provider intent is created with a provider idempotency key per order; the client secret is never stored (unit; PG (CI) with the fake adapter; Stripe sandbox: real run).
- Stripe webhook: signature on the raw body, digits-only timestamp within 300 s, multiple `v1` signatures accepted during a secret roll (unit). The order is marked paid only if the intent status is `succeeded`, `amount_received` and `amount` equal the order total, the currency matches and the intent is the one checkout stored; otherwise the mismatch is audited (unit).
- Webhook event record, state change, audit and outbox commit in one transaction; duplicates are acknowledged without effects. Unit-tested against an in-memory stand-in; the PostgreSQL integration test (duplicate delivery through the real unique constraint, P2002; amount and currency mismatch; rollback of event, state, audit and outbox on an injected failure, then a successful retry) runs in CI.
- Fake payments webhook (unsigned) closed when NODE_ENV=production; production refuses to start without an explicit `INTEGRATIONS_MODE` (unit); live mode refuses test keys (unit).
- Outbox: explicit handler per event type; unknown types are never marked delivered; dead-letter after 8 attempts with an `outbox_dead_letter` error log (unit; row claiming: PG (CI)).

Platform
- zod validation at the edge with 4xx; parameterized queries (Prisma); helmet CSP + HSTS; CORS allowlist; client `x-request-id` accepted only if it matches `^[\w-]{1,64}$` (unit).
- Secrets only in environment variables. AWS: no long-lived keys; CI assumes a per-project role through GitHub OIDC, and only the deploy jobs get `id-token: write` (real run). IAM write actions are limited to resources tagged `project=<name>` (real run; see `infra/README.md`).
- CI scanners: gitleaks CLI (full history), osv-scanner on the pnpm lockfile, semgrep `p/owasp-top-ten` in the official container, trivy on the image (HIGH and CRITICAL with a fix available) (real run).

## Roadmap before any production deploy (Módulo C 6.2)
2FA for admins and owners; ZAP baseline nightly against staging (job wired, needs `STAGING_URL`); restore test; OWASP ASVS L2 manual checklist signed; alerting on the `outbox_dead_letter` log line; Redis for rate limits before scaling the API beyond one instance.

## Verified only in a real CI run or Lightsail deploy
The authoring environment cannot download the Prisma engines or reach GitHub Actions and AWS. Not executed there: the PostgreSQL and Redis integration tests, `prisma migrate diff --exit-code` drift check, typecheck of code that needs the generated Prisma client, Playwright e2e, the scanners, the Docker build, OIDC role assumption, the IAM tag conditions and the deploy and smoke scripts. Record the outcome of the first real run in `docs/learnings.md`.
