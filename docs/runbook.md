# Runbook
## Deploy
First deploy of a new service: set DATABASE_URL, SESSION_SECRET, APP_URL, OPS_EMAIL, INTEGRATIONS_MODE and/or the per-integration modes PAYMENTS_MODE, MESSAGING_MODE, CARRIER_MODE, STORAGE_MODE (each must resolve in production, never defaulted; see docs/integrations/README.md), the provider of every non-fake integration and its keys (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET; OES_*; S3_*), TOTP_ENC_KEY (`openssl rand -base64 32`; required because infra/lightsail.json sets REQUIRE_PRIVILEGED_2FA=true), MESSAGING_PROVIDER with RESEND_API_KEY and MESSAGING_FROM when using Resend, and REDIS_URL if the API runs more than one instance, once with "aws lightsail create-container-service-deployment" from a local file outside the repo (deploy.sh only carries over the ACTIVE deployment's environment, and without these the API exits at boot). `APP_ENV` and `APP_VERSION` are set by deploy.sh. `deploy.sh` waits until the new deployment is ACTIVE (FAILED, INACTIVE or 10 minutes: exit 1 with the last log lines of every container, and the previous deployment keeps serving); the usual cause of FAILED is `Invalid environment: { VARIABLE: [rule] }` at boot. Then: staging: merge to main → CI deploys. prod: `git tag vX.Y.Z && git push --tags` → approve in GitHub environment → Jaime approves in chat.
## AWS credentials
CI deploys with GitHub OIDC: the deploy jobs (only they have `id-token: write`) assume `AWS_ROLE_STAGING` or `AWS_ROLE_PROD` with `aws-actions/configure-aws-credentials`. Humans use a short-lived session for the same role (`aws sso login` or `aws sts assume-role` with MFA). No IAM user access keys exist for deploys. Policy and trust details: `infra/README.md`.
## Rollback
`infra/rollback.sh <service> <version>`; verify with `infra/smoke.sh`.
## Backups and restore
Managed DB automatic daily snapshots. Restore test quarterly: create DB from snapshot, point staging to it, run smoke.
## Outbox dead letters
The worker logs `"event":"outbox_dead_letter"` (error level) when an event fails 8 times. Find them with `SELECT id, type, "lastError" FROM "Outbox" WHERE "deadLetteredAt" IS NOT NULL;`, fix the cause, then replay as described in `packages/db/prisma/migrations/20261021120200_outbox_dead_letter/ROLLBACK.md`.
## Incidents
1. Declare in LOGBOOK with time. 2. Check /api/health, container logs (`aws lightsail get-container-log`). 3. Rollback if a deploy caused it. 4. Notify client with the template in docs/handover. 5. Postmortem within 48 h.
## Monthly
Dependabot PRs, review the deploy roles' OIDC trust policies (repository and environment conditions) and who can assume them; there are no long-lived IAM keys to rotate, review costs, review docs/learnings.md.

## Worker environment
The `worker` container validates the same environment as the API (`DATABASE_URL`, `SESSION_SECRET`, `APP_URL`, `OPS_EMAIL`, `APP_ENV`, the integration modes and their secrets). `infra/deploy.sh` copies the `app` container's variables into `worker` on every deployment; if you set variables by hand in the Lightsail console, set them on BOTH containers.

## Redis outage
With `REDIS_URL` set, a Redis outage keeps ordinary routes serving (rate limits fail open) and makes login answer 429 (fails closed). `/api/health` shows `deps.redis: down`.

## Two-factor authentication (2FA)
- A staff user lost the phone: they sign in with one of their 10 recovery codes, then disable and re-enroll (or regenerate codes). If they have no codes left, the owner runs `POST /api/v1/users/:id/2fa/reset` (audited as `mfa_reset`, revokes their sessions); the user enrolls again at the next sign-in.
- The owner lost the phone and every recovery code: owners cannot reset themselves through the API. With Jaime's explicit approval, after verifying the owner's identity out of band, a second owner of the tenant resets them; if there is none, run on the database `UPDATE "User" SET "totpSecret" = NULL, "totpEnabledAt" = NULL, "totpLastStep" = NULL, "sessionVersion" = "sessionVersion" + 1 WHERE id = '<owner id>'; DELETE FROM "MfaRecoveryCode" WHERE "userId" = '<owner id>';` and add an AuditLog row by hand (`action = 'mfa_reset'`, `actor = 'ops:<your name>'`).
- `TOTP_ENC_KEY` rotation or loss: every enrolled secret and recovery-code hash depends on it. Rotating means every 2FA user re-enrolls: set the new key, clear 2FA for all users with the statement above (without the WHERE on id), deploy, and announce it. Never rotate it silently. Store it in the password manager of the group, not only in Lightsail.
- Bursts of `"event":"mfa_failed"` log lines or `mfa_failed` audit rows for one user mean someone has (or is guessing) that user's password: reset their password and sessions.

## Messaging (Resend)
`MESSAGING_MODE` sandbox or live needs `MESSAGING_PROVIDER=resend`, `RESEND_API_KEY` and `MESSAGING_FROM` (default on staging: `OctavoLab Staging <noreply@24hcargo.com>`); the API and worker refuse to start without them. Sandbox mode sends only to `delivered@resend.dev` and the addresses in `MESSAGING_ALLOW_LIST`. Outbox rows with `lastError` like `resend 401 invalid_api_key` retry with backoff until the key is fixed; `resend 422 validation_error` rows are dead-lettered at once. Details: `docs/integrations/resend.md`.

## Integrations health
`GET /api/health` shows `modes` (per integration) and `deps.payments` (`ok | degraded`, Stripe `GET /v1/balance` cached 60 s). `degraded` does not fail the probe: check the `payments_probe_failed` log line (`stripe balance 401 error` = wrong or revoked key; `network`/`timeout` = Stripe or egress problem). Checkout answers 503 `PROVIDER_ERROR` while Stripe is unavailable, 502 for a rejected request. OES quotes fail fast with `circuit_open` for 30 s after 5 consecutive failures.

## Memory on the Nano service
After a deploy that adds a dependency, and monthly, run the memory check in `infra/README.md` (Capacity). Above 80 % maximum over 24 h, or an out-of-memory line in `aws lightsail get-container-log`, ask Jaime to approve scaling to Micro (`aws lightsail update-container-service --region eu-west-2 --service-name octavolab-staging --power micro`).

## Sentry
Errors and sampled traces go to the `24h-logistics` organisation only when `SENTRY_DSN` is set (`environment` = APP_ENV, `release` = deployed version). Dead-lettered outbox events appear as `outbox_dead_letter` issues. Details and what is scrubbed: `docs/integrations/sentry.md`.
