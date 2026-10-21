# Runbook
## Deploy
First deploy of a new service: set DATABASE_URL, SESSION_SECRET, APP_URL, REDIS_URL and provider keys once with "aws lightsail create-container-service-deployment" from a local file outside the repo (deploy.sh only carries over the ACTIVE deployment's environment, and without these the API exits at boot). Then: staging: merge to main → CI deploys. prod: `git tag vX.Y.Z && git push --tags` → approve in GitHub environment → Jaime approves in chat.
## Rollback
`infra/rollback.sh <service> <version>`; verify with `infra/smoke.sh`.
## Backups and restore
Managed DB automatic daily snapshots. Restore test quarterly: create DB from snapshot, point staging to it, run smoke.
## Incidents
1. Declare in LOGBOOK with time. 2. Check /api/health, container logs (`aws lightsail get-container-log`). 3. Rollback if a deploy caused it. 4. Notify client with the template in docs/handover. 5. Postmortem within 48 h.
## Monthly
Dependabot PRs, rotate project IAM keys every 90 days, review costs, review docs/learnings.md.
