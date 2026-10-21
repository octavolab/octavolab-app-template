# octavolab-app-template

Plantilla del grupo OctavoLab para software real (Módulo S y Módulo C del kit): monorepo TypeScript con API transaccional, web responsive, integraciones con adaptadores, seguridad en CI y despliegue en AWS Lightsail (staging y producción).

## Para Jaime (en 1 minuto)
- Qué es: el punto de partida de todo proyecto nuevo. Hoy trae base de datos con migraciones, API transaccional, autenticación con sesiones firmadas, rotación y revocación en el servidor (cerrar sesión o cambiar el rol invalida la sesión al instante), roles, aislamiento estricto por tenant (sin tenant compartido), límite de intentos de login por cuenta e IP, cobro de pedidos por el equipo (`POST /orders/:id/checkout`) y por el propio cliente (`/me/orders`: el cliente arma su pedido con los productos y precios del catálogo del tenant, paga, y solo ve sus propios pedidos), máquina de estados de pedidos, verificación en dos pasos (2FA con app autenticadora y 10 códigos de recuperación) para dueños y equipo, obligatoria para el dueño en staging y producción, correos reales vía Resend (en sandbox solo a la bandeja de prueba de Resend), auditoría (incluidos login, logout y cada cambio de 2FA) y outbox con reintentos y cola de mensajes muertos; 129 pruebas unitarias y de API, más 15 pruebas de integración contra PostgreSQL y Redis que corren en CI. Hoja de ruta antes del primer despliegue a producción: panel de administración e interfaz (catálogo, pedidos del cliente, pantallas de 2FA) con shadcn/ui, passkeys, colas BullMQ.
- Cómo se corre: ver "Quick start" abajo (incluye `cp .env.example .env`) y abrir http://localhost:5173 (web) y http://localhost:3000/api/health (API).
- Cómo se despliega: un push a `main` despliega a staging (la ejecución nocturna no despliega); una etiqueta `vX.Y.Z` despliega a producción tras aprobación manual. CI entra a AWS con un rol por proyecto vía OIDC, sin llaves guardadas.
- Cómo se revierte: `infra/rollback.sh <service> <version>` (Lightsail conserva las últimas versiones).
- A quién llamar: tech lead del grupo (en `OWNERSHIP.md`).

## Quick start (developers)
Requires Node 22, pnpm 9 (`corepack enable`) and Docker. Every command runs from the repository root.
```bash
pnpm install
cp .env.example .env            # read by the API (node --env-file) and the db scripts (dotenv-cli)
docker compose up -d            # postgres :5432 + redis :6379
pnpm db:generate                # Prisma client (downloads the Prisma engines on first run)
pnpm db:migrate && pnpm db:seed # applies packages/db/prisma/migrations; seed needs SEED_ADMIN_PASSWORD in .env
pnpm dev                        # api :3000 (src, watch), web :5173 (proxies /api to :3000)
pnpm --filter api dev:worker    # optional, second terminal: outbox worker
```
To try 2FA locally, set `TOTP_ENC_KEY` in `.env` (`openssl rand -base64 32`); without it the 2FA endpoints answer 503.

## API at a glance (full contract: `docs/openapi.json`)
| Who | Endpoints |
|---|---|
| Everyone | `POST /api/v1/auth/login` (answers `{ mfaRequired: true }` when 2FA is on), `POST /api/v1/auth/login/mfa`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` |
| Customer | `GET /api/v1/products`, `POST/GET /api/v1/me/orders`, `GET /api/v1/me/orders/:id`, `POST /api/v1/me/orders/:id/checkout` |
| Staff (owner, admin, operations) | `POST /api/v1/orders`, `GET /api/v1/orders/:id`, `POST /api/v1/orders/:id/checkout`, `POST /api/v1/auth/2fa/{enroll,activate,disable,recovery-codes}` |
| Owner, admin | `PUT /api/v1/products/:sku` |
| Owner | `PATCH /api/v1/users/:id/role`, `POST /api/v1/users/:id/2fa/reset` |
| Provider | `POST /api/v1/webhooks/payments` (signed) |
Checks:
```bash
npx vitest run                                  # unit and API tests (in-memory Prisma stand-in), from the root
pnpm --filter @octavolab/db validate:sql        # replays every migration on PGlite (no Docker needed)
INTEGRATION=1 pnpm --filter api test:int        # integration tests against the PostgreSQL (and Redis) from docker compose
pnpm exec playwright install chromium webkit && pnpm e2e   # 390, 768, 1024 and 1440 px + axe
UPDATE_OPENAPI=1 npx vitest run apps/api/src/routes/api.test.ts   # regenerate docs/openapi.json after changing routes
```
`pnpm dev` and `pnpm e2e` (outside CI) start the servers themselves; `pnpm build && pnpm --filter web preview` serves the built web app, also proxying `/api`.

## Verified locally vs only in a real run
| Check | Where it is verified |
|---|---|
| Unit and API tests (129), in-memory Prisma stand-in, including IDOR tests for customer orders, RFC 6238 vectors, Resend with a mocked fetch | Locally and in CI (`npx vitest run`) |
| Coverage thresholds of `apps/api` (lines 95, branches 85, functions 93) | Locally and in CI (`pnpm --filter api test`; measured 97.7 / 87.6 / 96.0) |
| Lint; typecheck of `packages/integrations`, `packages/db`, `packages/ui`, `apps/web` | Locally and in CI |
| Typecheck of `apps/api` | CI only: it needs the generated Prisma client (`pnpm db:generate`); locally only the errors caused by the missing client remain |
| All migrations applied in order on PostgreSQL (PGlite) | Locally and in CI (`pnpm --filter @octavolab/db validate:sql`) |
| Migrations match `schema.prisma` (`prisma migrate diff --exit-code`) | CI only |
| Integration tests (15) on PostgreSQL 16 and Redis 7, including catalog uniqueness, customer-order foreign key and the concurrent single-use TOTP step and recovery-code updates | CI only (`INTEGRATION=1 pnpm --filter api test:int`) |
| A real email through Resend (sandbox inbox), sender domain verification | First real run with a Resend key (checklist in `docs/integrations/resend.md`) |
| 2FA enrollment with a real authenticator app (Google Authenticator, 1Password, Authy) scanning the otpauth URI | Manual check on staging (the URI format is unit-tested) |
| Playwright e2e and axe at 390, 768, 1024, 1440 px | CI only (or locally with browsers installed) |
| gitleaks, osv-scanner, semgrep, trivy, Docker build | CI only |
| OIDC role assumption, IAM tag conditions, Lightsail deploy, smoke, rollback | First real staging deploy (checklist in `infra/README.md`) |

## Structure
```
apps/api            Fastify + TypeScript, /api/v1, OpenAPI (docs/openapi.json), transactions, outbox, audit log, checkout (staff and customer), catalog, TOTP 2FA
apps/web            React + Vite + Tailwind v4, responsive 390/768/1024/1440 (dev and preview proxy /api)
packages/db         Prisma schema, hand-checked migrations (PostgreSQL 16), PGlite migration replay
packages/integrations  Adapters: PaymentGateway (fake, Stripe), CarrierRates (fake), MessagingProvider (fake, Resend)
packages/ui         Shared UI tokens and components
infra/              Dockerfile, lightsail.json, deploy.sh, rollback.sh, smoke.sh, IAM policy (see infra/README.md)
docs/               ADRs, runbook, onboarding, integrations, data model, OpenAPI, handover
.github/workflows   CI: lint, typecheck, tests, integration tests, e2e, semgrep, gitleaks, osv-scanner, trivy, deploy
```

See `CLAUDE.md` for the rules any agent or developer follows in this repo.
