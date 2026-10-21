# Changelog
All notable changes to this project are documented here (Keep a Changelog, semver).

## [0.3.0] - 2026-10-21
### Fixed (independent review, round 2)
- Initial SQL migration (validated on PostgreSQL via PGlite: 8 tables, indexes, foreign keys) with migration_lock and a rollback plan; CI checks migrations exist.
- Outbox claims rows with FOR UPDATE SKIP LOCKED and lockedUntil (a second worker gets zero rows, verified), exponential backoff, non-overlapping loop.
- /api/health returns 503 when the database is down.
- Order totals guarded against the 32-bit minor-unit column.
- README, ARCHITECTURE, runbook, ADR and PR template describe only what exists; roadmap items labeled (N52).
- IAM policy and CODEOWNERS notes; approvals in CLAUDE.md no longer imply a single grouped approval per session.

## [0.2.0] - 2026-10-21
### Fixed (independent review)
- deploy.sh carries over the ACTIVE deployment environment (Lightsail replaces the whole deployment).
- Stripe webhook signature verification with 300 s tolerance; live mode refuses test keys; tests added.
- Adapter selection throws instead of silently returning fake adapters outside fake mode; test added.
- Validation errors return 4xx with code and requestId; API serves the web build with SPA fallback.
- Node 22 LTS image and CI; .dockerignore; lightsailctl installed in deploy jobs; nightly schedule for ZAP.
- Workspace packages build to dist with a development export condition; coverage thresholds as a ratchet.
- SECURITY.md separates what is implemented from roadmap (N52).

## [0.1.0] - 2026-10-21
### Added
- Template: API (Fastify, zod, Prisma, outbox, audit log, idempotency), web (React, Vite, Tailwind), integrations adapters, CI with security scanners, Lightsail deploy scripts, docs.
