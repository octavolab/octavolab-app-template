# Secrets: threat model and controls (staging and production on Lightsail)

Rotation procedures: `docs/runbook.md` → "Rotate secrets" (Spanish: `docs/runbook.es.md`). Future platform: ADR 0006.

## The secrets
| Secret | Protects | If it leaks |
|---|---|---|
| `DATABASE_URL` (password) | All tenant data. | Full read/write of the database by anyone who can reach it (the managed database is private: reachable only from the service, unless public mode is switched on). |
| `SESSION_SECRET` | Session and 2FA-step cookie signatures; key of the email pseudonyms in logs. | Forged sessions for any user, until rotated (rotation logs everyone out). |
| `TOTP_ENC_KEY` | TOTP seeds at rest (AES-256-GCM) and recovery-code hashes (HMAC). | Combined with a database copy: every user's second factor. Alone: nothing. |
| Provider keys (`STRIPE_*`, `RESEND_API_KEY`) | Payments, email. | Charges/refunds or email in our name (none configured on staging today: `INTEGRATIONS_MODE=fake`). |
| Owner password | The tenant. | Account takeover is blocked by 2FA; rotate it anyway. |

## Where they live today, and why
Lightsail container services have **no IAM task role**: a container cannot fetch secrets from AWS at runtime without
long-lived AWS keys in its own environment, which would be a worse secret than the ones it protects. So secrets are
**plaintext Lightsail environment variables** of the `app` container (copied to `worker` by `infra/deploy.sh`).
`infra/deploy.sh` can also merge a Secrets Manager secret at deploy time (the deploy role reads it with short-lived OIDC
credentials); the values still end up as Lightsail environment variables. We do not add any runtime Secrets Manager client.

## Threats and controls
| Threat | Control |
|---|---|
| Anyone with Lightsail console/API read access sees every value, including in old deployments (the history cannot be deleted). | Lightsail access is limited to Jaime and the deploy role; the deploy role has no console users and no keys. A value that ever appeared in a deployment is treated as known to every past and present Lightsail reader: rotate it when that group changes. This is why the owner password set through `BOOTSTRAP_OWNER_PASSWORD` (deployment v9) must be rotated and why that mechanism was removed. |
| Secrets in CI logs. | `infra/deploy.sh` never prints environment values (deploy diff is by key name; the create-deployment response is queried for its version only). Before this change the full deployment response, environment included, was printed: past CI logs of staging deploys may contain secrets; delete those workflow runs' logs or rotate (manual action). |
| Secrets in the repository, chat, tickets or PR text. | Never. gitleaks runs on the full history in CI; tests generate secrets at runtime. |
| Weak, placeholder or truncated secrets (typed by hand, copied from `.env.example`). | The API and the worker refuse to boot in production: `SESSION_SECRET` ≥ 32 characters, no placeholder words, no repeated pattern, ≥ 10 distinct characters, ≥ 3.0 bits/char and ≥ 128 bits estimated entropy; `TOTP_ENC_KEY` exactly 32 bytes with ≥ 16 distinct bytes; `DATABASE_URL` with a password ≥ 16 characters, not localhost. Messages name the variable and the rule, never the value. The checks cannot tell a long human passphrase from random data: always generate secrets. |
| A password kept in env to create the first user. | Removed: `create-owner` CLI reads it from a hidden prompt or stdin. `BOOTSTRAP_*` variables make the API refuse to boot. |
| Stale or hand-edited copies (app and worker disagreeing, `APP_VERSION` stale). | The worker always receives the app's values on deploy; the version is baked into the image, not an env var. |
| Container compromise (RCE). | Out of scope of these controls: a compromised process reads its own environment on any platform. Mitigations are the usual ones (dependencies scanned by osv-scanner and trivy, non-root user, no npm in the runtime image). |

## Residual risk accepted for staging
Plaintext env in the Lightsail control plane, visible in the deployment history. Acceptable while staging holds demo data
and `INTEGRATIONS_MODE=fake`. Before production holds real customer data or live provider keys, decide on ADR 0006
(ECS Fargate with task roles and Secrets Manager references), or accept this residual risk explicitly (Jaime, N07).
