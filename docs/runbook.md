# Runbook
## Deploy
First deploy of a new service: set DATABASE_URL, SESSION_SECRET, APP_URL, OPS_EMAIL, INTEGRATIONS_MODE (required in production, never defaulted), PAYMENTS_PROVIDER and provider keys (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET), and REDIS_URL if the API runs more than one instance, once with "aws lightsail create-container-service-deployment" from a local file outside the repo (deploy.sh only carries over the ACTIVE deployment's environment, and without these the API exits at boot). Then: staging: merge to main → CI deploys. prod: `git tag vX.Y.Z && git push --tags` → approve in GitHub environment → Jaime approves in chat.
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
The `worker` container validates the same environment as the API (`DATABASE_URL`, `SESSION_SECRET`, `APP_URL`, `OPS_EMAIL`, `INTEGRATIONS_MODE`). `infra/deploy.sh` copies the `app` container's variables into `worker` on every deployment; if you set variables by hand in the Lightsail console, set them on BOTH containers.

## Redis outage
With `REDIS_URL` set, a Redis outage keeps ordinary routes serving (rate limits fail open) and makes login answer 429 (fails closed). `/api/health` shows `deps.redis: down`.
