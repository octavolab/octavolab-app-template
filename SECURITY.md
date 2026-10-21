# Security
Report: security@octavolab.com (replace with the group address). Do not open public issues for vulnerabilities.

Implemented today (template v0.1): zod validation at the edge with 4xx (not 500) on validation errors, Stripe webhook signature check with timestamp tolerance and tests, live-mode guard (no fake adapters outside fake mode), parameterized queries (Prisma), helmet CSP + HSTS, CORS allowlist, global rate limit (100/min/IP), request id + redacted logs, secrets only in environment, gitleaks + semgrep + osv-scanner + trivy in CI.
Roadmap before any production deploy (Módulo C 6.2): Argon2id passwords, short rotating sessions, 2FA for admins, authorization per resource and tenant with IDOR tests, rate limit on auth and public forms, ZAP baseline nightly (job wired, needs STAGING_URL), restore test, IAM role per project (OIDC) with MFA.
