# Learnings

What this project taught us. General items go to the kit (Módulo L) by PR at phase close.

- 2026-10-21: template created.
- 2026-10-21 (v0.6.0): tests against an in-memory Prisma stand-in cannot prove database semantics (unique violations, rollback); keep a PostgreSQL integration test for every transactional guarantee and say which kind of test backs each claim in the docs.
- 2026-10-21 (v0.6.0): a scheduled workflow also runs with `github.ref == refs/heads/main`; gate deploys on `github.event_name == 'push'`.
- 2026-10-21 (v0.6.0): login limits keyed only by account let an attacker lock a user out; key by account + IP and keep a global per-IP limit.
- Pending, record after the first real run: IAM tag conditions per Lightsail action, Prisma engine in the alpine image, Redis address inside the Lightsail service, OIDC trust policy.

