# Security
Report: security@octavolab.com (replace with the group address). Do not open public issues for vulnerabilities.

## Implemented today (template v0.7.0)
How each control is checked is stated next to it:
- **unit**: unit or API test that runs locally and in CI against an in-memory Prisma stand-in (`npx vitest run`).
- **PG (CI)**: integration test against a real PostgreSQL 16 (and Redis) that runs in CI only (`INTEGRATION=1 pnpm --filter api test:int`); written and reviewed, not executed in the authoring environment.
- **real run**: only a real CI run or Lightsail deploy confirms it (see the bottom of this file).

Authentication and sessions
- Argon2id passwords; constant-work login for unknown emails; same error for unknown email and wrong password (unit).
- Signed short-lived session cookie (HMAC-SHA256, httpOnly, Secure in production, SameSite=Strict), rotated after half its life, 12-hour absolute lifetime from sign-in (unit).
- Server-side revocation: the token carries the user's `sessionVersion`; every authenticated request re-reads the user by primary key and rejects the token (401 SESSION_REVOKED) if the user is gone or its session version, role or tenant changed. Logout and role changes increment `sessionVersion`, which ends every session of that user on every device (unit).
- Login rate limit 5/min per (email, client IP): an attacker cannot lock a user out from another IP; global limit `RATE_LIMIT_MAX` (default 100/min) per IP; proxy trust limited to one hop (unit). Counters live in Redis when `REDIS_URL` is set (PG (CI): shared counter across two API instances against the CI Redis). Without `REDIS_URL` they live in process memory: correct only while the service runs a single API instance, because each instance would count separately.
- Security events (ASVS 7.2.1): `login_failed` is logged with a keyed HMAC fingerprint of the email, never the email or the password; request body passwords are redacted; AuditLog rows for `login` (with the method: `password`, `password+totp`, `password+recovery_code`), `logout` and `role_change` (unit).

Two-factor authentication (TOTP, RFC 6238), staff and owner roles (customers: 403)
- TOTP implemented with `node:crypto` only (no dependency): SHA-1, 6 digits, 30 s steps, +/- 1 step of drift, constant-time comparison; checked against the RFC 6238 Appendix B vectors for SHA-1, SHA-256 and SHA-512 and the RFC 4226 Appendix D HOTP values (unit).
- Single use: the last accepted time step is stored and advanced with one conditional UPDATE, so a code (or an older one) is refused after use (unit; concurrent requests: PG (CI)).
- Enrollment: 160-bit secret from the CSPRNG, generated server-side; the otpauth URI and base32 secret are returned once with `Cache-Control: no-store`; 2FA is enabled only after a valid code (unit).
- At rest: the secret is AES-256-GCM ciphertext (`v1.<iv>.<tag>.<ct>`, 96-bit random IV) under a key derived with HKDF-SHA256 from `TOTP_ENC_KEY` (32 bytes, environment only); the associated data binds it to the user id, so a value copied to another row does not decrypt; anything else (a legacy plaintext value, a wrong key, tampering) fails closed (unit).
- Recovery codes: 10 per activation, 50 bits each, shown once; stored only as HMAC-SHA256 under a second HKDF sub-key with the user id as salt; each one works once (conditional UPDATE on `usedAt IS NULL`); regenerating them invalidates the old set (unit; concurrency: PG (CI)).
- Login: the password is checked first and the answer is identical for a wrong password whether or not the account has 2FA; only after a correct password does the API answer `{ mfaRequired: true }` with a 5-minute httpOnly `mfa` cookie (path `/api/v1/auth`, SameSite=Strict) and no session. That token is signed with a purpose-specific key, carries the user's `sessionVersion` and is never accepted as a session (unit).
- Rate limits on every code check (login step, activate, disable, regenerate): 5 attempts per 5 minutes per (user, IP) and 20 failed codes per 24 hours per user across all IPs; successful logins do not count toward the daily cap; fails closed if Redis is down (unit). Accepted trade-off: someone who already has the password can block that user's second step for up to 24 hours.
- Activation, disable and owner reset revoke the user's sessions (`sessionVersion + 1`) and re-issue the caller's cookie; disable needs the password and a second factor (unit).
- `REQUIRE_OWNER_2FA=true` (set in `infra/lightsail.json`): owners AND admins (the roles that change prices, roles and orders) without 2FA can sign in but every route except `/auth/me` and enrollment answers 403 `MFA_ENROLLMENT_REQUIRED`, and they cannot disable 2FA (unit). Operations staff may enable it voluntarily. An owner's 2FA is never reset by another owner through the API (409 `OWNER_MFA_RESET`); it follows the runbook with an out-of-band identity check (unit). Demoting a user to customer clears their TOTP secret and recovery codes (unit). The `/me/orders` cursor must be one of the caller's own orders (400 `BAD_CURSOR`) (unit). Without `TOTP_ENC_KEY`, 2FA endpoints and the login of an account with 2FA answer 503; it never falls back to password-only (unit).
- Audit: `mfa_enroll_started`, `mfa_enabled`, `mfa_failed` (stage and reason, never the code), `mfa_disabled`, `mfa_reset`, `mfa_recovery_codes_regenerated`, `login_mfa_challenge`; logs carry user ids only (unit: codes, recovery codes, secrets and passwords absent from the log stream).

Authorization and tenancy
- Role checks; `/orders` routes are staff only (unit).
- Customer self-service (`/me/orders`, role `customer` only): every read and the checkout are filtered by tenant AND `Order.customerUserId = caller`; another customer's order (same or other tenant), a staff-created order with the customer's email and a missing id all answer the same 404 (unit: IDOR tests for read, list and checkout, including with the owner's Idempotency-Key; PG (CI)).
- Customers send SKUs and quantities only; the body schema is strict (unknown fields such as `unitAmount`, `currency`, `tenantId` or `customerUserId` are 400, no mass assignment) and prices come from the tenant's active `Product` rows (unit).
- No shared tenant: tenant-scoped routes return 403 TENANT_REQUIRED for a user without a tenant; `Order.tenantId` is NOT NULL in the database (unit; NOT NULL enforced: PG (CI)). Another tenant's order returns 404 (unit).
- Role changes: owner-only, inside the owner's tenant, never on oneself (unit).

Data integrity and payments
- Idempotency-Key scoped by tenant (and by customer for `/me` routes) and bound to the request: the stored sha256 of the canonical JSON of the operation and input must match, otherwise 422 IDEMPOTENCY_MISMATCH (unit; PG (CI)). Two customers using the same key never see each other's response (unit).
- Checkout (`POST /api/v1/orders/:id/checkout` for staff, `POST /api/v1/me/orders/:id/checkout` for the owning customer): one code path, tenant-scoped, idempotent; the provider intent is created with a provider idempotency key per order; the client secret is never stored (unit; PG (CI) with the fake adapter; Stripe sandbox: real run).
- Stripe webhook: signature on the raw body, digits-only timestamp within 300 s, multiple `v1` signatures accepted during a secret roll (unit). The order is marked paid only if the intent status is `succeeded`, `amount_received` and `amount` equal the order total, the currency matches and the intent is the one checkout stored; otherwise the mismatch is audited (unit).
- Webhook event record, state change, audit and outbox commit in one transaction; duplicates are acknowledged without effects. Unit-tested against an in-memory stand-in; the PostgreSQL integration test (duplicate delivery through the real unique constraint, P2002; amount and currency mismatch; rollback of event, state, audit and outbox on an injected failure, then a successful retry) runs in CI.
- Fake payments webhook (unsigned) closed when NODE_ENV=production; production refuses to start unless every integration mode (`PAYMENTS_MODE`, `MESSAGING_MODE`, `CARRIER_MODE`, `STORAGE_MODE`, or `INTEGRATIONS_MODE` as their default) resolves explicitly (unit); `live` requires `ALLOW_LIVE=true`, accepted only with `APP_ENV=production` (unit); provider keys must match the mode: no live Stripe key in sandbox, no test key in live (unit); Stripe webhook events whose `livemode` differs from the mode are rejected (unit); Sentry events are scrubbed of PII and secrets (unit).
- Outbox: explicit handler per event type; unknown types are never marked delivered; dead-letter after 8 attempts, or at once for an error marked non-retryable, with an `outbox_dead_letter` error log (unit; row claiming: PG (CI)).
- Messaging (Resend, `MESSAGING_PROVIDER=resend`): key only in the Authorization header; errors reduced to `resend <status> <name>` (never the key, the recipient or the provider's free text), so outbox `lastError` and logs hold no secret or personal data; 10 s timeout; provider idempotency key `outbox:<eventId>`; sandbox mode only sends to `delivered@resend.dev`; template values HTML-escaped and stripped of line breaks (unit with a mocked fetch; real send: real run).

Platform
- zod validation at the edge with 4xx; parameterized queries (Prisma); helmet CSP + HSTS; CORS allowlist; client `x-request-id` accepted only if it matches `^[\w-]{1,64}$` (unit).
- Secrets only in environment variables. AWS: no long-lived keys; CI assumes a per-project role through GitHub OIDC, and only the deploy jobs get `id-token: write` (real run). IAM write actions are limited to resources tagged `project=<name>` (real run; see `infra/README.md`).
- CI scanners: gitleaks CLI (full history), osv-scanner on the pnpm lockfile, semgrep `p/owasp-top-ten` in the official container, trivy on the image (HIGH and CRITICAL with a fix available) (real run).

## OWASP ASVS 4.0.3 mapping (controls added in 0.7.0)
| ASVS | Requirement (short) | Where | Status |
|---|---|---|---|
| 2.2.1 | Anti-automation on authentication | `lib/login-limiter.ts` (`createMfaLimiter`) | Met (unit; Redis store: PG (CI)) |
| 2.6.1 | Look-up secrets used once | `recoveryCodesRepo.use` | Met (unit; concurrency PG (CI)) |
| 2.6.2 | Look-up secrets: 112 bits, or salted and hashed | `lib/secret-box.ts` | Partial: 50 bits per code, keyed HMAC-SHA256 with the user id as salt (stronger offline than a public salt), online rate limits; raise to 112 bits if a client requires strict compliance |
| 2.6.3 | Look-up secrets resistant to offline attacks | keyed HMAC, key outside the database | Met (unit) |
| 2.8.1 | Time-based OTP has a defined lifetime | 30 s step, +/- 1 step | Met (unit) |
| 2.8.3 | Approved cryptographic algorithms for OTP | HMAC-SHA1 per RFC 6238 (apps' default) | Met (unit, RFC vectors) |
| 2.8.4 | TOTP used only once within its validity period | `usersRepo.consumeTotpStep` | Met (unit; concurrency PG (CI)) |
| 2.8.5 | Reused or failed OTP logged | `mfa_failed` audit row and log line | Met (unit); alerting on it: roadmap |
| 3.2.1 | New session token on authentication | session issued only after the second factor | Met (unit) |
| 3.3.3 | Terminate other sessions after an authentication factor change | activate, disable, reset bump `sessionVersion` | Met (unit) |
| 4.2.1 | Protection against IDOR | `/me/orders` owner filter, staff routes role-gated | Met (unit; PG (CI)) |
| 5.1.2 | Mass parameter assignment | strict zod schemas on `/me/orders` and 2FA bodies | Met (unit) |
| 6.2.1, 6.2.2 | Fail securely; approved algorithms and modes | AES-256-GCM, HKDF-SHA256, HMAC-SHA256; decrypt fails closed | Met (unit) |
| 6.3.1 | Random values from a CSPRNG | `crypto.randomBytes` for secrets, IVs, codes | Met (code review) |
| 6.4.1 | Keys in a secrets management solution | `TOTP_ENC_KEY`, `RESEND_API_KEY` as Lightsail environment variables | Partial: env vars, not a KMS; rotation documented in `docs/runbook.md` |
| 7.1.1 | No credentials or secrets in logs | Resend error mapping, MFA logs | Met (unit) |
| 8.2.1 | Anti-caching headers for sensitive data | `Cache-Control: no-store` on enroll, activate, recovery codes | Met (unit) |

## Roadmap before any production deploy (Módulo C 6.2)
WebAuthn or passkeys as a phishing-resistant factor (TOTP is not); alerting on `mfa_failed` bursts; ZAP baseline nightly against staging (job wired, needs `STAGING_URL`); restore test; OWASP ASVS L2 manual checklist signed; alerting on the `outbox_dead_letter` log line; Redis for rate limits before scaling the API beyond one instance.

## Verified only in a real CI run or Lightsail deploy
The authoring environment cannot download the Prisma engines or reach GitHub Actions and AWS. Not executed there: the PostgreSQL and Redis integration tests (including `self-service-mfa.int.test.ts`: unique index, foreign keys, cursor pagination and the concurrent single-use updates for TOTP steps and recovery codes), a real Resend send, `prisma migrate diff --exit-code` drift check, typecheck of code that needs the generated Prisma client, Playwright e2e, the scanners, the Docker build, OIDC role assumption, the IAM tag conditions and the deploy and smoke scripts. Record the outcome of the first real run in `docs/learnings.md`.
