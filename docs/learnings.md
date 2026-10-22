# Learnings

What this project taught us. General items go to the kit (Módulo L) by PR at phase close.

- 2026-10-21: template created.
- 2026-10-21 (v0.6.0): tests against an in-memory Prisma stand-in cannot prove database semantics (unique violations, rollback); keep a PostgreSQL integration test for every transactional guarantee and say which kind of test backs each claim in the docs.
- 2026-10-21 (v0.6.0): a scheduled workflow also runs with `github.ref == refs/heads/main`; gate deploys on `github.event_name == 'push'`.
- 2026-10-21 (v0.6.0): login limits keyed only by account let an attacker lock a user out; key by account + IP and keep a global per-IP limit.
- 2026-10-22 (v0.7.0): a test double that returns live row references hides bugs real Prisma would show (a service read `sessionVersion` after its own increment). Test doubles must copy on read.
- 2026-10-22 (v0.7.0): a per-account daily cap that counts successful attempts locks out heavy legitimate users; count failures for the long window, every attempt for the short one.
- 2026-10-22 (v0.7.0): self-service endpoints must never accept prices from the client; bind the Idempotency-Key to the client body before pricing so retries replay after a price change.
- 2026-10-22 (v0.7.0): a sandbox mode for a messaging provider must not reach real people; rewrite recipients to the provider's test inbox.
- 2026-10-22 (v0.8.0): one global integrations mode blocks partial adoption: staging could not use real Stripe while the carrier had no sandbox. Give every integration its own mode with the global one as default, and validate the whole set at boot.
- 2026-10-22 (v0.8.0): `create-container-service-deployment` returns before the new version is live, so a smoke test right after it checks the previous deployment. Poll until ACTIVE and make the smoke test compare the reported version.
- 2026-10-22 (v0.8.0): printing the output of `create-container-service-deployment` writes the whole environment (secrets) into the CI log; query only the field you need.
- 2026-10-22 (v0.8.0): `@sentry/node` 11 brings an FSL-licensed CLI into runtime dependencies; check `pnpm licenses list` when adding an SDK, not only its own license.
- 2026-10-22 (v0.8.0): new AWS SDK versions add CRC32 checksums to PutObject by default, which breaks pre-signed browser uploads; set `requestChecksumCalculation: "WHEN_REQUIRED"`.
- Pending, record after the first real run: Stripe and Resend sandbox sends from staging, deploy.sh polling against real Lightsail, Sentry events and source maps, IAM tag conditions per Lightsail action, Prisma engine in the alpine image, Redis address inside the Lightsail service, OIDC trust policy.

