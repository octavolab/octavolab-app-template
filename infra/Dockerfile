# Multi-stage build: web static files are served by the API container.
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm db:generate && pnpm build

FROM node:20-alpine AS runtime
RUN corepack enable && addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=base /app ./
ENV NODE_ENV=production PORT=3000
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["sh", "-c", "pnpm db:migrate && node apps/api/dist/server.js"]
