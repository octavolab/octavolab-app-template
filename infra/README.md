# infra

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage image (Node 22 alpine + openssl). Runtime runs `prisma migrate deploy` from `packages/db/node_modules/.bin` and then the API; no Corepack or pnpm at runtime. |
| `lightsail.json` | Container service deployment template (`app`, `worker`, `redis`). |
| `deploy.sh` | Build, push and deploy to a Lightsail container service, carrying over the ACTIVE deployment's environment. |
| `rollback.sh` | Re-activate a previous deployment version. |
| `smoke.sh` | Post-deploy smoke test (health, home, HSTS). |
| `iam-policy-project.json` | Permissions policy for the per-project deploy role. |

## AWS credentials (one model everywhere)
There are no long-lived access keys. CI assumes a per-project IAM role through GitHub OIDC
(`aws-actions/configure-aws-credentials` with `role-to-assume`, secrets `AWS_ROLE_STAGING` and `AWS_ROLE_PROD`).
Only the deploy jobs get `id-token: write`. A human running `deploy.sh` locally uses a short-lived session for the
same role (`aws sso login` or `aws sts assume-role` with MFA), never an IAM user key.

The role's trust policy must restrict `token.actions.githubusercontent.com:sub` to this repository and environment, for example
`repo:<org>/<repo>:environment:staging` for the staging role and `repo:<org>/<repo>:environment:production` for the production role.

## The permissions policy
`iam-policy-project.json` contains the literal placeholders `${PROJECT_NAME}` and `${ENV_NAME}` (`staging` or `prod`, the same value `deploy.sh` receives). Create one policy per environment:

```bash
PROJECT_NAME=acme ENV_NAME=staging envsubst '${PROJECT_NAME} ${ENV_NAME}' < infra/iam-policy-project.json > /tmp/policy.json
aws iam create-policy --policy-name "acme-deploy-staging" --policy-document file:///tmp/policy.json
```

- `ProjectSecrets` is scoped to `<PROJECT_NAME>/<ENV_NAME>-*` (Secrets Manager appends a 6-character suffix to the name), so the staging role can never read `<PROJECT_NAME>/prod`. A policy created before 0.7.4 with `<PROJECT_NAME>/*` must be updated to this scope before the production secret exists (IAM change: Jaime applies it, N07).

- Read and list actions (`Get*`) are on `*` because Lightsail does not support resource-level permissions for them; the list is the minimum `deploy.sh`, `rollback.sh` and the runbook use.
- `CreateContainerServiceRegistryLogin` (used by `lightsailctl` during `aws lightsail push-container-image`) has no resource type, so it cannot be scoped.
- Write actions (`RegisterContainerImage`, `CreateContainerServiceDeployment`, `CreateRelationalDatabaseSnapshot`) are allowed only on resources tagged `project=<PROJECT_NAME>`. Tag the container services and the database when you create them.
- Destructive actions are denied explicitly.

## Verified locally vs only in a real run
Verified locally: the policy is valid JSON; the Dockerfile CMD paths match the pnpm layout of this repo (`packages/db/node_modules/.bin/prisma`, `apps/api/dist/server.js`). The action names were taken from the Lightsail Service Authorization Reference but have not been exercised against AWS.

Only a real AWS run confirms (check on the first staging deploy and record the result in `docs/learnings.md`):
1. `aws lightsail push-container-image` succeeds with this policy (registry login + register image on a tagged service).
2. `aws:ResourceTag/project` is evaluated for `RegisterContainerImage`, `CreateContainerServiceDeployment` and `CreateRelationalDatabaseSnapshot`: deploying to an UNTAGGED service must fail with AccessDenied, and to the tagged one must succeed. If an action returns AccessDenied on the tagged resource, Lightsail does not evaluate the tag for it: move it to a statement scoped by the resource ARN instead and note it here.
3. IAM Access Analyzer (`aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY`) returns no errors.
4. The OIDC trust policy rejects a workflow run from another repository or environment.
5. The image builds with the correct Prisma engine (`linux-musl-openssl-3.0.x`) and `prisma migrate deploy` runs at container start before the API listens.
