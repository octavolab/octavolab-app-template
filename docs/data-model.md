# Data model
See `packages/db/prisma/schema.prisma`; migrations in `packages/db/prisma/migrations` (each with a ROLLBACK.md).

- Order states: draft -> confirmed -> paid -> shipped -> delivered -> closed; checkout: draft or confirmed -> pending_payment -> paid; cancelled from draft, confirmed or pending_payment; refunded from paid or delivered. The state machine lives in `apps/api/src/lib/order-state.ts`; transitions are optimistic on `Order.version`.
- `Order.tenantId` is required: every order belongs to one tenant. `User.tenantId` may be null (such users cannot use tenant routes: 403).
- `Order.paymentIntentId` (unique): the provider intent created by `POST /orders/:id/checkout`; the webhook only accepts a payment for that intent.
- `User.sessionVersion`: incremented on logout and role change; session tokens carry it and stop working when it changes.
- `IdempotencyKey`: key `<tenantId>:<client key>`, `requestHash` = sha256 of the canonical JSON of the operation and input, stored response.
- `Outbox`: `attempts`, `lastError`, `lockedUntil` (lease), `deliveredAt`, `deadLetteredAt` (set after 8 failed attempts).
- Money: integer minor units + ISO 4217 currency. Every business write adds AuditLog and (if it has external effects) Outbox.
