# CLAUDE.md · instrucciones permanentes para cualquier agente o developer

kit: octavolab-core (versión vigente, hoy 6.9.3) · módulos: S (software dinámico), C (ingeniería de producción), L (aprendizaje)

## Lo que nunca se toca
- Secretos: nunca en el repositorio ni en el chat. `.env` está ignorado. Producción usa variables de entorno de Lightsail.
- `main` protegida: todo entra por pull request con revisión humana. Sin `force push`.
- Comandos destructivos (borrar base de datos, eliminar servicios de Lightsail, `prisma migrate reset` en staging o producción) solo con aprobación explícita de Jaime en el turno.
- Pagos, envíos, correos o mensajes reales solo con llaves de producción cargadas por Jaime y modo `live` en esa integración (`PAYMENTS_MODE`, `MESSAGING_MODE`, `CARRIER_MODE`, `STORAGE_MODE` o `INTEGRATIONS_MODE`) con `ALLOW_LIVE=true`, que solo Jaime pone en producción (ADR 0005).

## Cómo se trabaja (Módulo C, 2.2)
1. Historia con criterio de aceptación antes del código.
2. Rama `feat/<id>-<nombre>`; Conventional Commits.
3. Orden: migración y modelo → servicio → endpoint con validación zod → interfaz → pruebas → docs (OpenAPI, CHANGELOG, docs/).
4. Antes del PR: `pnpm check` (lint, typecheck, unit, e2e, semgrep, gitleaks). Capturas en 390, 768, 1024 y 1440 px.
5. PR con la plantilla de `.github/PULL_REQUEST_TEMPLATE.md`.

## Reglas de código (Módulo C, 3 y 4)
- TypeScript strict; `any` prohibido sin comentario de justificación.
- Capas: routes → services → repositories → db. Reglas de negocio solo en services.
- Toda escritura de negocio en transacción; endpoints que crean dinero, pedidos o mensajes aceptan `Idempotency-Key`.
- Efectos externos por outbox (`packages/db` tabla `Outbox`), nunca dentro de la transacción. Excepción documentada: el checkout crea la intención de pago de forma síncrona ANTES de la transacción, con llave de idempotencia del proveedor por pedido (ver ARCHITECTURE.md, flujo 2).
- Dinero en enteros (unidad menor) con `currency` ISO. Fechas en UTC.
- Toda entidad de negocio escribe en `AuditLog`.
- Textos de interfaz en `apps/web/src/i18n/{es,en}.json`.

## Comandos
- `pnpm dev` · `pnpm test` · `pnpm e2e` · `pnpm check` · `pnpm db:migrate` · `pnpm db:seed` · `pnpm build` · `pnpm --filter @octavolab/db validate:sql` (migraciones en PGlite) · `INTEGRATION=1 pnpm --filter api test:int` (PostgreSQL real)
- Despliegue: `infra/deploy.sh staging|prod` (prod solo con aprobación). Humo: `infra/smoke.sh <url>`.

## Aprobaciones de Jaime (N07): se agrupan cuando coinciden en el tiempo; lo que surge después se pide en su momento; nada irreversible sin aprobación
Repositorio y accesos · cuentas en proveedores · llaves de producción · primer cobro o envío real · despliegue a producción · costos recurrentes · comandos destructivos.

## Aprendizaje (Módulo L)
Lo aprendido en este repo va a `docs/learnings.md`; al cierre de fase, lo general sube al kit por PR.
