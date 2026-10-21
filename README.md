# octavolab-app-template

Plantilla del grupo OctavoLab para software real (Módulo S y Módulo C del kit): monorepo TypeScript con API transaccional, web responsive, integraciones con adaptadores, seguridad en CI y despliegue en AWS Lightsail (staging y producción).

## Para Jaime (en 1 minuto)
- Qué es: el punto de partida de todo proyecto nuevo. Hoy trae base de datos con migración inicial, API transaccional, autenticación con sesiones firmadas y rotación, roles, aislamiento por tenant (sin IDOR), límite de intentos de login, webhooks de pago firmados y deduplicados, máquina de estados de pedidos, auditoría y outbox con bloqueo de filas; 21 pruebas unitarias y de API más pruebas de integración contra PostgreSQL en CI. Hoja de ruta antes del primer despliegue a producción: 2FA para administradores, panel de administración, colas BullMQ, interfaz con shadcn/ui y exportación de OpenAPI.
- Cómo se corre: `pnpm install && docker compose up -d && pnpm db:migrate && pnpm dev` y abrir http://localhost:5173 (web) y http://localhost:3000/api/health (API).
- Cómo se despliega: CI despliega `main` a staging; una etiqueta `vX.Y.Z` despliega a producción tras aprobación manual.
- Cómo se revierte: `infra/rollback.sh <service> <version>` (Lightsail conserva las últimas versiones).
- A quién llamar: tech lead del grupo (en `OWNERSHIP.md`).

## Quick start (developers)
```bash
pnpm install
cp .env.example .env
docker compose up -d            # postgres + redis
pnpm db:migrate && pnpm db:seed
pnpm dev                        # api :3000, web :5173
pnpm test && pnpm e2e           # vitest + playwright (390, 768, 1024 y 1440 px)
```

## Structure
```
apps/api            Fastify + TypeScript, /api/v1, OpenAPI, transactions, outbox, audit log
apps/web            React + Vite + Tailwind v4 + shadcn/ui style, responsive 390/768/1024/1440
packages/db         Prisma schema and migrations (PostgreSQL 16)
packages/integrations  Adapters: PaymentGateway, CarrierRates, MessagingProvider (+ fake implementations)
packages/ui         Shared UI tokens and components
infra/              Dockerfile, lightsail.json, deploy.sh, rollback.sh, smoke.sh
docs/               ADRs, runbook, onboarding, integrations, data model, handover
.github/workflows   CI: lint, typecheck, tests, e2e, semgrep, gitleaks, osv-scanner, trivy, deploy
```

See `CLAUDE.md` for the rules any agent or developer follows in this repo.
