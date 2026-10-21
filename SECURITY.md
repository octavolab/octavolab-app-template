# Security
Report: security@octavolab.com (replace with the group address). Do not open public issues for vulnerabilities.

Controls (OWASP ASVS L2): Argon2id passwords, short rotating sessions, 2FA for admins, server-side authorization per resource and tenant, zod validation at the edge, parameterized queries (Prisma), CSP + HSTS + secure cookies, rate limiting on auth and public forms, secrets only in environment, gitleaks + semgrep + osv-scanner + trivy in CI, ZAP baseline nightly against staging, encrypted backups, IAM user per project with MFA.
