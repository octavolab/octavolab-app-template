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
- Write actions (`RegisterContainerImage`, `CreateContainerServiceDeployment`, `CreateRelationalDatabaseSnapshot`) are allowed only on resources tagged `project=<PROJECT_NAME>` AND `env=<ENV_NAME>` (since 0.7.5), so the staging role cannot deploy to production. Tag the container services and the database with both tags when you create them. **Existing resources created before 0.7.5 carry only `project`: add `env=staging` to the staging service and database BEFORE applying the new policy, or the next staging deploy fails with AccessDenied.**

## Production gate (enforced in AWS)
Required reviewers on environments of private repositories need GitHub Enterprise, and environments themselves need GitHub Pro, Team or Enterprise in private repositories (docs.github.com, "Managing environments for deployment", read 22 Oct 2026). The `staging` environment secret works in this repository today, which suggests the organization plan includes environments [to verify in the organization's billing settings]; without environments the `context` claim is never `environment:production` and production cannot deploy at all (fails closed). A `v*` tag runs the workflow file of the tagged commit, so an `if:` in `ci.yml` alone can be removed by anyone with write access. The gate therefore lives in the AWS trust, outside the repository:
1. Customize the repository's OIDC subject (Jaime, once): GitHub REST `PUT /repos/<org>/<repo>/actions/oidc/customization/sub` with `{"use_default": false, "include_claim_keys": ["repo", "context", "ref", "actor_id"]}`. Expected subject: `repo:<org>/<repo>:environment:<env>:ref:<git ref>:actor_id:<numeric id>` [verify the exact format in the first token, docs.github.com "OpenID Connect reference", on the day]. `actor_id` and not `actor`: a login can be renamed and then registered by someone else.
2. BEFORE step 1 takes effect, change the staging role trust to `StringLike` `repo:<org>/<repo>:environment:staging:ref:refs/heads/main:actor_id:*`, or staging deploys stop.
3. The prod role `<project>-deploy-prod` trusts only `StringLike` `repo:<org>/<repo>:environment:production:ref:refs/tags/v*:actor_id:<approver id>` (the id from `GET /users/<login>`). Credentials then need all three: the `production` environment, a `v*` tag ref, and a run started by the approver.
4. Residual risk, by design: a writer can put a workflow of their own (using `environment: production`, without the `if`) into a commit, and if the approver later tags that commit, it runs with the approver's identity. So the approver tags only commits on `main` that passed review, and checks the `.github/` changes in the range being released (`git diff <last tag>..HEAD -- .github/`) before tagging.
5. Re-runs: the workflow also checks `github.triggering_actor`; whether a re-run by another user changes the `actor_id` claim is [to verify, record in docs/learnings.md].
6. Also, where the plan allows it: a tag ruleset on `refs/tags/v*` restricted to admins, and a deployment-tag policy `v*` on the `production` environment (both GitHub Pro or Team). Treat the deployment-tag policy as required, not optional, when available.
The workflow `if` (`PROD_APPROVER`, actor and triggering actor) is defense in depth only. The chat approval (N07) still applies before the tag is pushed.

Production resources are tagged `project=<PROJECT_NAME>` and `env=prod` (the value `deploy.sh` receives, not the GitHub environment name `production`); the production policy is created with `ENV_NAME=prod`.

## Verified locally vs only in a real run
Verified locally: the policy is valid JSON; the Dockerfile CMD paths match the pnpm layout of this repo (`packages/db/node_modules/.bin/prisma`, `apps/api/dist/server.js`). The action names were taken from the Lightsail Service Authorization Reference but have not been exercised against AWS.

Only a real AWS run confirms (check on the first staging deploy and record the result in `docs/learnings.md`):
1. `aws lightsail push-container-image` succeeds with this policy (registry login + register image on a tagged service).
2. `aws:ResourceTag/project` and `aws:ResourceTag/env` are evaluated for `RegisterContainerImage`, `CreateContainerServiceDeployment` and `CreateRelationalDatabaseSnapshot`: deploying to an UNTAGGED service must fail with AccessDenied, the staging role deploying to the `env=prod` service must fail with AccessDenied, and the matching service must succeed. If an action returns AccessDenied on the tagged resource, Lightsail does not evaluate the tag for it: move it to a statement scoped by the resource ARN instead and note it here.
3. IAM Access Analyzer (`aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY`) returns no errors.
4. The OIDC trust policy rejects a workflow run from another repository or environment.
5. The image builds with the correct Prisma engine (`linux-musl-openssl-3.0.x`) and `prisma migrate deploy` runs at container start before the API listens.
