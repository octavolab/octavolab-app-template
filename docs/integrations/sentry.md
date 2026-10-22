# Sentry (errors and traces)
- Purpose: error reporting and sampled traces for the API, the outbox worker and the web app.
- Official docs (URL, date read): https://docs.sentry.io/platforms/javascript/guides/node/ (ESM `--import` setup),
  https://docs.sentry.io/platforms/javascript/guides/react/, https://docs.sentry.io/cli/releases/, read 2026-10-22.
  SDK major version 10 (`@sentry/node`, `@sentry/react`): version 11 pulls an FSL-licensed CLI into the runtime
  dependencies, which `OWNERSHIP.md` does not allow.
- Organisation: `24h-logistics`, data region US (`*.ingest.us.sentry.io`).
- Owner: tech lead in `OWNERSHIP.md`.

## Configuration
| Variable | Where | Meaning |
|---|---|---|
| `SENTRY_DSN` | Lightsail (app; copied to worker) | backend project DSN. Unset = Sentry fully disabled (default) |
| `SENTRY_WEB_DSN` | Lightsail (app) | browser project DSN (public by design); defaults to `SENTRY_DSN` |
| `SENTRY_TRACES_SAMPLE_RATE` | optional | 0..1; default 0.1 on staging, 0.05 in production |
| `APP_ENV`, `APP_VERSION` | set by deploy.sh | Sentry `environment` and `release` (= `git describe --tags --always`) |
| `SENTRY_AUTH_TOKEN` | GitHub secret | source map upload in CI; skipped when absent |
| `SENTRY_ORG`, `SENTRY_PROJECT_WEB` | GitHub variables | upload target; `SENTRY_ORG` defaults to `24h-logistics` |

## How it is wired
- API and worker: `apps/api/src/instrument.ts` is preloaded with `node --import` (Dockerfile CMD, worker command in
  `infra/lightsail.json`, `pnpm start`), so http, fastify and pg are instrumented. Unhandled errors and provider errors are
  captured in the Fastify error handler; the worker reports dead-lettered outbox events (`outbox_dead_letter`) and loop errors.
- Web: `apps/web/src/sentry.ts` reads `GET /api/client-config` at start-up and loads the SDK lazily only when a DSN is set;
  the CSP `connect-src` adds the DSN's ingest origin automatically.
- Privacy: `sendDefaultPii: false`; `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb` remove the user, cookies,
  request bodies, query strings and auth/signature/idempotency headers, and mask Stripe/Resend/AWS keys, bearer tokens,
  connection-string passwords and email addresses in every message, exception, extra and breadcrumb.
- Source maps: the web build emits hidden source maps; `infra/sentry-sourcemaps.sh` uploads them in the deploy jobs when the
  `SENTRY_AUTH_TOKEN` secret exists (sentry-cli runs as a pinned one-off tool, it is not a dependency), and the Dockerfile
  deletes them from the image. Server stack traces are mapped at runtime (`--enable-source-maps`).

## Verified
- Locally and in CI: options, sample rates and scrubbing (`apps/api/src/lib/sentry.test.ts`, `apps/web/src/sentry.test.ts`),
  client config and CSP origin, dead-letter alert hook.
- Only in a real run: events arriving in the `24h-logistics` projects, source map resolution for a release.
