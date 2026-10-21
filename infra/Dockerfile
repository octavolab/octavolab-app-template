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

FROM node:22-alpine AS runtime
# No corepack and no pnpm at runtime: nothing is downloaded when the container starts.
RUN apk add --no-cache openssl && addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=base /app ./
ENV NODE_ENV=production PORT=3000
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/api/health || exit 1
# The Prisma CLI is a dependency of packages/db (pnpm keeps its bin there, not in the root node_modules/.bin).
# The worker container overrides this command (infra/lightsail.json), so only the app container migrates.
CMD ["sh", "-c", "packages/db/node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma && node apps/api/dist/server.js"]
