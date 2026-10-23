# Runbook
## Deploy
Staging: merge to `main` → CI runs `infra/deploy.sh staging` (GitHub OIDC role, one staging deploy at a time) and then
`infra/smoke.sh`. Never deploy by hand while CI is deploying, and never edit variables in the console during a deploy.

**Production** (GitHub Free plan: no required reviewers or tag rulesets on this private repository, so the gate is in AWS):
1. Jaime approves in chat (N07).
2. The approver checks the workflow changes being released: `git diff <last tag>..HEAD -- .github/`.
3. The user named in the repository variable `PROD_APPROVER` pushes the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. `deploy.sh prod` pushes the image, merges the secret, takes the snapshot `<project>-prod-db-pre-<sha>-<UTC time>` and
   waits until it is `available`. No snapshot, no deploy.
5. Migrations run when the new app container starts (ADR 0005). If one fails, the new container fails its health check and
   the previous deployment stays active.
Credentials: only the approver gets production credentials once the AWS trust in infra/README.md "Production gate" is in
place. Until then the workflow `if` is the only check, and a writer can bypass it.

What `infra/deploy.sh` guarantees (details in the script header):
1. **Lock.** It aborts (exit 3, nothing changed) if Lightsail shows a deployment in progress (`DEPLOYING`, `UPDATING`,
   `PENDING`, or a deployment `ACTIVATING`), and again if the ACTIVE deployment changed while it ran (someone deployed or
   saved a console edit). Re-run it after the other change finished; it then builds on top of that change.
2. **Console edits are kept.** The new environment starts from the CURRENT active deployment (`infra/deploy_env.py`).
   The template only sets `NODE_ENV`, `PORT`, `REQUIRE_PRIVILEGED_2FA`; Secrets Manager values (if that secret exists) win
   for the app. Deploy-managed keys are removed: `APP_VERSION` (now baked into the image) and any `BOOTSTRAP_*`.
   The worker always receives the app's values, so app and worker cannot disagree (for example on `INTEGRATIONS_MODE`).
3. **Diff by name.** Before deploying it prints, per container, the variable NAMES added (`+`), removed (`-`) and changed
   (`~`). Values are never printed; read the diff in the CI log before approving anything unexpected.
4. **Version.** The image is built with `--build-arg GIT_SHA=$(git rev-parse --short=7 HEAD)` and `/api/health` reports
   that SHA from `/app/VERSION`. The script refuses a dirty working tree, waits until the NEW deployment version is
   `ACTIVE` (15 min max), and prints each container's log tail if it ends `FAILED`/`INACTIVE`/times out (the previous
   version keeps serving).
5. **Smoke.** `infra/smoke.sh <url>` fails unless `/api/health` is `ok:true` AND `version` equals the deployed SHA.

First deploy of a brand-new service: create it with the variables listed in "Rotate secrets" (generated values, never
typed passwords) using `aws lightsail create-container-service-deployment` from a file outside the repo, then deploy
normally. The API refuses to boot without them or with weak values (`Invalid environment: { VARIABLE: [rule] }`, names
and rules only). Production in live mode also needs `ALERT_WEBHOOK_URL` (runbook "Alerts").
## AWS credentials
CI deploys with GitHub OIDC: the deploy jobs (only they have `id-token: write`) assume `AWS_ROLE_STAGING` or `AWS_ROLE_PROD` with `aws-actions/configure-aws-credentials`. Humans use a short-lived session for the same role (`aws sso login` or `aws sts assume-role` with MFA). No IAM user access keys exist for deploys. Policy and trust details: `infra/README.md`.
## Rollback
`infra/rollback.sh <service> <version>`; verify with `infra/smoke.sh`.
## Backups and restore
Managed DB automatic daily snapshots. Restore test before the first production launch and then quarterly (ASVS accepted item; done by Jaime with his SSO profile, because the deploy role cannot create or delete databases). It creates a temporary paid database (smallest plan, billed by the hour, price shown in the console first) and needs Jaime's "yes" in chat (N07):
1. Automatic backups are point-in-time: restore the latest restorable time of `<project>-staging-db` (or `-prod-db`). For a manual snapshot instead, list them with `aws lightsail get-relational-database-snapshots --region eu-west-2`.
2. `aws lightsail create-relational-database-from-snapshot --region eu-west-2 --relational-database-name <project>-restore-test --source-relational-database-name <project>-staging-db --use-latest-restorable-time --relational-database-bundle-id <smallest bundle> --no-publicly-accessible --tags key=project,value=<project> key=env,value=restore-test` (manual snapshot: `--relational-database-snapshot-name <snapshot>` instead of the two source options). Flags taken from the Lightsail CLI reference; confirm with `aws lightsail create-relational-database-from-snapshot help` on the day.
3. Wait until it is `available` (about 10 to 20 minutes). Note the time from start to available: that is the measured recovery time.
4. In the staging secret (`<project>/staging` in Secrets Manager), temporarily set `DATABASE_URL` to the restored endpoint (same master user and password as the source; `?sslmode=require`) AND `INTEGRATIONS_MODE=fake`, so the worker does not re-send outbox rows that were pending at snapshot time. Re-run the last `deploy-staging` job in GitHub Actions (main only accepts changes through a pull request).
5. Check: `infra/smoke.sh <STAGING_URL>` green; sign in as the owner (2FA) and open the latest orders; `SELECT count(*)` of `Order`, `User`, `AuditLog` match the source within the snapshot time.
6. Put the original `DATABASE_URL` and `INTEGRATIONS_MODE` back in the secret and redeploy; smoke green again.
7. Delete `<project>-restore-test` (Jaime, console; deletion is denied to the deploy role).
8. Record in `docs/LOGBOOK.md`: date, snapshot name and time, measured recovery time, counts compared, result, who ran it. Until a row exists, SECURITY.md keeps "restore test" as an accepted open item.
## Outbox dead letters
The worker logs `"event":"outbox_dead_letter"` (error level) when an event fails 8 times. Find them with `SELECT id, type, "lastError" FROM "Outbox" WHERE "deadLetteredAt" IS NOT NULL;`, fix the cause, then replay as described in `packages/db/prisma/migrations/20261021120200_outbox_dead_letter/ROLLBACK.md`.
## Rolling out 0.7.5 (operations 2FA)
From 0.7.5, with `REQUIRE_PRIVILEGED_2FA=true`, operations users without 2FA get 403 `MFA_ENROLLMENT_REQUIRED` on every route except enrollment. Before deploying it: list them (`SELECT email FROM "User" WHERE role = 'operations' AND "totpEnabledAt" IS NULL;`), ask them to enroll on the current version (enrollment is already available to operations), and deploy when the list is empty or the remaining users are told they will be asked at their next request.
## Alerts (worker, every 60 s)
**Rules** (counted from the database):
- `mfa_failed_spike`: at least `MFA_FAILED_ALERT_THRESHOLD` (default 10) failed second-factor attempts in the last 15 minutes, all users together.
- `outbox_dead_letter`: any outbox event dead-lettered since the last delivered alert (so none are lost while the rule is cooling down).

**Delivery:**
- A JSON POST to `ALERT_WEBHOOK_URL`, plus an error log line `"event":"alert_fired"`.
- Format: a Slack incoming webhook works as is (it reads `text`). Discord and Teams need a relay that reshapes the JSON.
- `ALERT_WEBHOOK_URL` must be https and is required when `INTEGRATIONS_MODE=live`. It is a credential: keep it in the environment's secret in AWS Secrets Manager.
- Each rule fires at most once an hour per worker process, counted from a successful delivery. A failed delivery is retried every minute. A worker restart resets the hour.

**Testing** (after every change to the webhook): in staging, dead-letter a test event or lower the threshold for a moment, and confirm the message arrives. `alert_delivery_failed` in the log means the webhook is wrong or down.

**Response:**
- `mfa_failed_spike`: run `SELECT "entityId", after->>'ip' AS ip, count(*) FROM "AuditLog" WHERE action = 'mfa_failed' AND "createdAt" > now() - interval '15 minutes' GROUP BY 1, 2 ORDER BY 3 DESC;`.
  - One user from many IPs: the password has probably leaked. Reset the password and revoke the sessions.
  - Many users from one IP: credential stuffing. The per-user limits already hold; consider blocking the IP at the edge.
- `outbox_dead_letter`: see "Outbox dead letters" above.
## Incidents
1. Declare in LOGBOOK with time. 2. Check /api/health, container logs (`aws lightsail get-container-log`). 3. Rollback if a deploy caused it. 4. Notify client with the template in docs/handover. 5. Postmortem within 48 h.
## Monthly
- Snapshots: every production deploy keeps one manual snapshot (`<project>-prod-db-pre-*`). Keep the last 5 and those of the last 90 days; Jaime deletes older ones in the console (the deploy role cannot delete).
- Dependabot PRs, review the deploy roles' OIDC trust policies (repository and environment conditions) and who can assume them; there are no long-lived IAM keys to rotate, review costs, review docs/learnings.md.

## Worker environment
The `worker` container validates the same environment as the API (`DATABASE_URL`, `SESSION_SECRET`, `APP_URL`, `OPS_EMAIL`, `INTEGRATIONS_MODE`). `infra/deploy.sh` copies the `app` container's variables into `worker` on every deployment (the app's value wins); if you set variables by hand in the Lightsail console, set them on BOTH containers, and they are aligned on the next deploy anyway. Both containers log one `"event":"startup"` line with `version` and `integrationsMode`: they must match.

## Redis outage
With `REDIS_URL` set, a Redis outage keeps ordinary routes serving (rate limits fail open) and makes login answer 429 (fails closed). `/api/health` shows `deps.redis: down`.

## Two-factor authentication (2FA)
- A staff user lost the phone: they sign in with one of their 10 recovery codes, then disable and re-enroll (or regenerate codes). If they have no codes left, the owner runs `POST /api/v1/users/:id/2fa/reset` (audited as `mfa_reset`, revokes their sessions); the user enrolls again at the next sign-in.
- The owner lost the phone and every recovery code: owners cannot reset themselves through the API. With Jaime's explicit approval, after verifying the owner's identity out of band, a second owner of the tenant resets them; if there is none, run on the database `UPDATE "User" SET "totpSecret" = NULL, "totpEnabledAt" = NULL, "totpLastStep" = NULL, "sessionVersion" = "sessionVersion" + 1 WHERE id = '<owner id>'; DELETE FROM "MfaRecoveryCode" WHERE "userId" = '<owner id>';` and add an AuditLog row by hand (`action = 'mfa_reset'`, `actor = 'ops:<your name>'`).
- `TOTP_ENC_KEY`: never rotate it like the other secrets; see "Rotate secrets" below. Store it in the password manager of the group, not only in Lightsail.
- Bursts of `"event":"mfa_failed"` log lines or `mfa_failed` audit rows for one user mean someone has (or is guessing) that user's password: reset their password and sessions.

## Messaging (Resend)
`MESSAGING_PROVIDER=resend` needs `RESEND_API_KEY` and `MESSAGING_FROM` (the API and worker refuse to start without them in test or live mode). Test mode sends only to `delivered@resend.dev`. Outbox rows with `lastError` like `resend 401 invalid_api_key` retry with backoff until the key is fixed; `resend 422 validation_error` rows are dead-lettered at once. Details: `docs/integrations/resend.md`.

## Secrets in AWS Secrets Manager (ASVS 6.4.1)
- One secret per environment, named `<PROJECT_NAME>/<env>` (for example `octavolab/staging`), region of the service, type "Other", value a flat JSON object: `{"DATABASE_URL": "...", "SESSION_SECRET": "...", "TOTP_ENC_KEY": "..."}` plus provider keys when the mode is test or live. Jaime types the values in the console; they never go in chat, tickets or the repo.
- Automatic first seed (staging only): when `<PROJECT_NAME>/<env>` does not exist and the deploy role has the `ProjectSecrets` statement, `infra/deploy.sh` creates it once from the active `app` environment (DATABASE_URL, SESSION_SECRET, TOTP_ENC_KEY, OPS_EMAIL), tagged project and env, without printing values. From then on the secret is the source of truth. Production never seeds: its secret must exist before the first deploy. Disable with `SEED_SECRET_FROM_ACTIVE=0`.
- The deploy role reads it (`ProjectSecrets` in `infra/iam-policy-project.json`, after the `${PROJECT_NAME}` and `${ENV_NAME}` substitution; scoped to `<project>/<env>-*`, so the staging role cannot read the production secret). `infra/deploy.sh` merges it into the `app` container (the worker inherits it) and logs only the key names it changes, never values.
- It is only read at deploy time with the deploy role's short-lived credentials; the containers hold no AWS keys. Production fails closed without it; staging falls back to the Lightsail environment with a CI warning while the secret is missing or unreadable (see `docs/secrets.md`).
- Rotate: see "Rotate secrets" below.
- Cost: AWS lists a per-secret monthly price; check it on the console before creating (N07).

## Create the owner (fresh environment)
The environment-variable bootstrap (`BOOTSTRAP_OWNER_*`) was removed: it left the password in the Lightsail deployment
history forever. The API now refuses to boot in production if any `BOOTSTRAP_*` variable is present.
Use the one-off CLI instead. It needs only `DATABASE_URL`, reads the password from a hidden prompt (typed twice) or from
stdin, never from arguments or environment variables, creates the demo tenant and price list if missing, and **never
modifies an existing user** (exit code 3, nothing written). Exit codes: 0 created, 2 usage/weak password, 3 exists.

- From a trusted machine with the repo (`DATABASE_URL` in `.env` or the shell, pointing at the target database):
  `pnpm create-owner --email owner@example.com`
- One-shot container from the deployed commit (Lightsail registry images cannot be pulled, so build the same commit:
  `git checkout <sha> && docker build -f infra/Dockerfile --build-arg GIT_SHA=<sha> -t app:<sha> .`), then:
  `docker run --rm -i -e DATABASE_URL app:<sha> node apps/api/dist/cli/create-owner.js --email owner@example.com`
  Use `-it` to be prompted (hidden input); with `-i` and a pipe it reads the first stdin line. Export `DATABASE_URL` first:
  `-e DATABASE_URL` without a value passes it without writing it on the command line.
- Reaching the Lightsail managed database: it is private by default. For a one-off run, Jaime enables public mode on the
  database for the few minutes needed, from a trusted network, runs the command over TLS, and disables public mode again;
  record it in `docs/LOGBOOK.md`. Never leave public mode on.

Then open the URL, sign in, enroll 2FA (`REQUIRE_PRIVILEGED_2FA=true`) and keep the recovery codes in the password manager.
Staging already has its owner (created with the old bootstrap in deployment v9; its password is visible in the deployment
history, so the owner rotates it from the app; 2FA is enabled).

## Rotate secrets
Threat model and why each secret exists: `docs/secrets.md`. Generate every value, never type one:
`openssl rand -base64 48` (SESSION_SECRET), `openssl rand -base64 32` (TOTP_ENC_KEY). The API refuses weak values in
production (length, placeholders, repeated patterns, entropy). Change values in the Lightsail console (app container;
the next deploy aligns the worker) or in the Secrets Manager secret, then redeploy. Never paste them in chat or tickets.

| Secret | Effect of rotating | Procedure |
|---|---|---|
| `SESSION_SECRET` | Every session and the 5-minute 2FA step cookie become invalid: everyone signs in again. Email pseudonyms in logs change (no correlation across the rotation). Safe. | New value → deploy → verify sign-in. |
| `DATABASE_URL` (password) | Brief errors if the app runs with the old password after the database changes. | Lightsail DB → change master password → immediately update `DATABASE_URL` → deploy → `/api/health` `deps.db: ok`. Do it in a quiet window. |
| `TOTP_ENC_KEY` | **Do not rotate it like the others.** It encrypts every user's TOTP seed and keys the recovery-code hashes. A new key makes every enrolled 2FA unreadable: owners and admins are locked out. | Planned rotation needs code that does not exist yet (key ids in the ciphertext, decrypt with old+new, re-encrypt job, then drop the old key; recovery codes must be regenerated by users because their hashes cannot be re-keyed). Until that ships, rotate only if the key is compromised: with Jaime's approval, set the new key, reset 2FA for all users (statement in "Two-factor authentication" without the `WHERE` on id), deploy, announce it, and every 2FA user re-enrolls. |
| Provider keys (`STRIPE_*`, `RESEND_API_KEY`) | None for users if done in order. | Create the new key in the provider, update the variable, deploy, verify, revoke the old key. |
| Owner password | That user only. | The owner changes it from the app (2FA keeps the account safe meanwhile). |

## Switch integration mode
`INTEGRATIONS_MODE` is `fake | test | live` (case-insensitive; the old name `sandbox` is accepted as `test`). App and worker
always receive the same value from `infra/deploy.sh`; both log it at startup and `/api/health` shows `mode`.

| Mode | What runs | Required variables (the API and worker refuse to boot without them) |
|---|---|---|
| `fake` | In-process adapters; nothing leaves the service. | None. Staging stays here until Jaime decides otherwise. |
| `test` | Stripe test mode, Resend test inbox. | `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY` (`sk_test_`/`rk_test_`), `STRIPE_WEBHOOK_SECRET` (`whsec_`), `MESSAGING_PROVIDER=resend`, `RESEND_API_KEY`, `MESSAGING_FROM`. |
| `live` | Real money and real messages. | Same as `test` with a LIVE Stripe key (`sk_live_`/`rk_live_`). Only with production keys loaded by Jaime and his approval (CLAUDE.md, N07). |

Procedure: add the required variables to the app container (console or Secrets Manager), set `INTEGRATIONS_MODE`, deploy,
check the `+`/`~` names in the deploy log, then check `/api/health` → `mode`. To go back, set `fake` and deploy. Carrier
quotes have no real adapter yet; they stay fake in every mode.
