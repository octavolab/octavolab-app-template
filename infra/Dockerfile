# Multi-stage build: web static files are served by the API container.
FROM node:22-alpine AS base
# Sprint 0: pin by digest after the first green build (node:22-alpine@sha256:<digest>), Módulo C 6.2
# openssl: Prisma detects the musl/OpenSSL 3 engine from it (without it, generate and migrate pick the wrong engine).
RUN apk add --no-cache openssl
# Corepack fetches the pnpm version pinned in package.json (packageManager) here, at build time only.
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate && pnpm build
# Browser source maps are only for the Sentry upload in CI (vite builds them "hidden"); never serve them.
RUN find apps/web/dist -name '*.map' -delete
# Runtime gets production dependencies only: build tools (esbuild, vite, typescript, vitest) never ship.
# A fresh prod-only install from the store (offline) leaves no dev packages in node_modules/.pnpm;
# the Prisma CLI is a production dependency of packages/db because the app container runs migrate deploy.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && CI=true pnpm install --prod --frozen-lockfile --offline \
 && pnpm --filter @octavolab/db generate

FROM node:22-alpine AS runtime
# No corepack and no pnpm at runtime: nothing is downloaded when the container starts.
# The base image bundles npm, npx and corepack; the app never uses them at runtime and npm's own
# dependencies carry HIGH advisories (trivy, first real run), so they are removed from the runtime image.
RUN apk add --no-cache openssl && addgroup -S app && adduser -S app -G app \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=base /app ./
ENV NODE_ENV=production PORT=3000
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/api/health || exit 1
# The Prisma CLI is a dependency of packages/db (pnpm keeps its bin there, not in the root node_modules/.bin).
# The worker container overrides this command (infra/lightsail.json), so only the app container migrates.
# --import preloads Sentry (a no-op without SENTRY_DSN); --enable-source-maps maps server stack traces to the TypeScript.
CMD ["sh", "-c", "packages/db/node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma && exec node --enable-source-maps --import ./apps/api/dist/instrument.js apps/api/dist/server.js"]
