# infra

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage image (Node 22 alpine + openssl). Runtime runs `prisma migrate deploy` from `packages/db/node_modules/.bin` and then the API; no Corepack or pnpm at runtime. |
| `lightsail.json` | Container service deployment template (`app`, `worker`, `redis`). |
| `deploy.sh` | Build, push and deploy to a Lightsail container service, carrying over the ACTIVE deployment's environment; waits until the new version is ACTIVE (exit 1 and container logs on FAILED/INACTIVE/10 min timeout). Sets `APP_ENV` (staging, production). |
| `rollback.sh` | Re-activate a previous deployment version. |
| `smoke.sh` | Post-deploy smoke test: `/api/health` must be `ok:true` AND report the version just deployed (`git describe --tags --always`); home; HSTS. |
| `sentry-sourcemaps.sh` | Uploads the web source maps for the release (deploy jobs, only when the `SENTRY_AUTH_TOKEN` secret exists). |
| `iam-policy-project.json` | Permissions policy for the per-project deploy role. |

## AWS credentials (one model everywhere)
There are no long-lived access keys. CI assumes a per-project IAM role through GitHub OIDC
(`aws-actions/configure-aws-credentials` with `role-to-assume`, secrets `AWS_ROLE_STAGING` and `AWS_ROLE_PROD`).
Only the deploy jobs get `id-token: write`. A human running `deploy.sh` locally uses a short-lived session for the
same role (`aws sso login` or `aws sts assume-role` with MFA), never an IAM user key.

The role's trust policy must restrict `token.actions.githubusercontent.com:sub` to this repository and environment.

### OIDC subject (immutable format)
GitHub now emits the **immutable** subject, which embeds the owner and repository ids, so renaming or re-creating the
organisation or repository cannot hand the role to someone else:

```
repo:octavolab@346244166/octavolab-app-template@1429393849:environment:staging
repo:octavolab@346244166/octavolab-app-template@1429393849:environment:production
```

Format: `repo:<owner>@<owner id>/<repo>@<repo id>:environment:<environment>`. The legacy form
(`repo:octavolab/octavolab-app-template:environment:staging`) is name-based.

**Staging** (`octavolab-deploy-staging`, applied): accepts both forms during the transition.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<account id>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": [
        "repo:octavolab@346244166/octavolab-app-template@1429393849:environment:staging",
        "repo:octavolab/octavolab-app-template:environment:staging"
      ] }
    }
  }]
}
```
Remove the legacy entry once a deploy has succeeded with the immutable subject (check the role's last-used information or
CloudTrail `AssumeRoleWithWebIdentity` events).

**Production** (the role in the `AWS_ROLE_PROD` secret, created with Jaime's approval, N07): **only** the immutable subject, with
`StringEquals` (no wildcard, no legacy form):
`"token.actions.githubusercontent.com:sub": "repo:octavolab@346244166/octavolab-app-template@1429393849:environment:production"`.
The GitHub `production` environment keeps its required reviewers, so a run reaches AWS only after a human approves it.

## The permissions policy
`iam-policy-project.json` contains the literal placeholder `${PROJECT_NAME}`. Substitute it before creating the policy:

```bash
PROJECT_NAME=acme envsubst '${PROJECT_NAME}' < infra/iam-policy-project.json > /tmp/policy.json
aws iam create-policy --policy-name "acme-deploy" --policy-document file:///tmp/policy.json
```

- Read and list actions (`Get*`) are on `*` because Lightsail does not support resource-level permissions for them; the list is the minimum `deploy.sh`, `rollback.sh` and the runbook use.
- `CreateContainerServiceRegistryLogin` (used by `lightsailctl` during `aws lightsail push-container-image`) has no resource type, so it cannot be scoped.
- Write actions (`RegisterContainerImage`, `CreateContainerServiceDeployment`, `CreateRelationalDatabaseSnapshot`) are allowed only on resources tagged `project=<PROJECT_NAME>`. Tag the container services and the database when you create them.
- Destructive actions are denied explicitly.

## Capacity: Nano runs three containers
`octavolab-staging` is a **Nano** service (512 MB RAM, 0.25 vCPU, scale 1) running `app` (API + web), `worker` and `redis`.
That is tight: two Node processes (each with Prisma's engine) plus Redis. Sentry tracing and the AWS SDK add memory. Symptoms of
pressure: containers restarting, health checks timing out, deployments stuck in ACTIVATING then FAILED.

Memory check (runbook, after every deploy that adds a dependency and monthly):
```bash
aws lightsail get-container-service-metric-data --region eu-west-2 --service-name octavolab-staging \
  --metric-name MemoryUtilization --statistics Average Maximum --unit Percent --period 300 \
  --start-time "$(date -u -d '-24 hours' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --query 'metricData[].[timestamp,average,maximum]' --output table
```
Scale up when the 24 h maximum stays above 80 % or a deployment fails with out-of-memory in `get-container-log`. One-line
command (a human runs it: Micro is 1 GB and a recurring cost change, so it needs Jaime's approval, N07; the deploy role is not
allowed to change the service):
```bash
aws lightsail update-container-service --region eu-west-2 --service-name octavolab-staging --power micro
```

## Verified locally vs only in a real run
Verified locally: the policy is valid JSON; the Dockerfile CMD paths match the pnpm layout of this repo (`packages/db/node_modules/.bin/prisma`, `apps/api/dist/server.js`). The action names were taken from the Lightsail Service Authorization Reference but have not been exercised against AWS.

Only a real AWS run confirms (check on the first staging deploy and record the result in `docs/learnings.md`):
1. `aws lightsail push-container-image` succeeds with this policy (registry login + register image on a tagged service).
2. `aws:ResourceTag/project` is evaluated for `RegisterContainerImage`, `CreateContainerServiceDeployment` and `CreateRelationalDatabaseSnapshot`: deploying to an UNTAGGED service must fail with AccessDenied, and to the tagged one must succeed. If an action returns AccessDenied on the tagged resource, Lightsail does not evaluate the tag for it: move it to a statement scoped by the resource ARN instead and note it here.
3. IAM Access Analyzer (`aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY`) returns no errors.
4. The OIDC trust policy rejects a workflow run from another repository or environment, and accepts the immutable subject.
5. The image builds with the correct Prisma engine (`linux-musl-openssl-3.0.x`) and `prisma migrate deploy` runs at container start before the API listens.
6. `deploy.sh` reads `containerService.nextDeployment.version` from `create-container-service-deployment` and the polling sees it reach ACTIVE (locally verified only against a stubbed `aws`).
