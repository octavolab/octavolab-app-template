# Multi-stage build: web static files are served by the API container.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base
# Base image pinned by digest (node:22-alpine as of 2026-10-22); Dependabot (docker) proposes updates after its 7-day cooldown.
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
# Runtime gets production dependencies only: build tools (esbuild, vite, typescript, vitest) never ship.
# A fresh prod-only install from the store (offline) leaves no dev packages in node_modules/.pnpm;
# the Prisma CLI is a production dependency of packages/db because the app container runs migrate deploy.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && CI=true pnpm install --prod --frozen-lockfile --offline \
 && pnpm --filter @octavolab/db generate

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
# No corepack and no pnpm at runtime: nothing is downloaded when the container starts.
# The base image bundles npm, npx and corepack; the app never uses them at runtime and npm's own
# dependencies carry HIGH advisories (trivy, first real run), so they are removed from the runtime image.
RUN apk add --no-cache openssl && addgroup -S app && adduser -S app -G app \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=base /app ./
# The deployed commit, baked into the image (read by apps/api/src/config/env.ts -> /api/health "version"). infra/deploy.sh
# and CI pass --build-arg GIT_SHA=$(git rev-parse --short=7 HEAD). Never an environment variable: Lightsail env values
# can be hand-edited or carried over stale between deployments. Anything but a hex SHA is recorded as "unknown" (health: "dev").
ARG GIT_SHA=unknown
RUN case "$GIT_SHA" in *[!0-9a-f]*|"") echo unknown;; *) echo "$GIT_SHA";; esac > /app/VERSION
LABEL org.opencontainers.image.revision=$GIT_SHA
ENV NODE_ENV=production PORT=3000
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/api/health || exit 1
# The Prisma CLI is a dependency of packages/db (pnpm keeps its bin there, not in the root node_modules/.bin).
# The worker container overrides this command (infra/lightsail.json), so only the app container migrates.
CMD ["sh", "-c", "packages/db/node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma && node apps/api/dist/server.js"]
