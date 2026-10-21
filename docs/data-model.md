# Data model
See `packages/db/prisma/schema.prisma`; migrations in `packages/db/prisma/migrations` (each with a ROLLBACK.md).

- Order states: draft -> confirmed -> paid -> shipped -> delivered -> closed; checkout: draft or confirmed -> pending_payment -> paid; cancelled from draft, confirmed or pending_payment; refunded from paid or delivered. The state machine lives in `apps/api/src/lib/order-state.ts`; transitions are optimistic on `Order.version`.
- `Order.tenantId` is required: every order belongs to one tenant. `User.tenantId` may be null (such users cannot use tenant routes: 403).
- `Order.paymentIntentId` (unique): the provider intent created by `POST /orders/:id/checkout`; the webhook only accepts a payment for that intent.
- `User.sessionVersion`: incremented on logout and role change; session tokens carry it and stop working when it changes.
- `IdempotencyKey`: key `<tenantId>:<client key>`, `requestHash` = sha256 of the canonical JSON of the operation and input, stored response.
- `Outbox`: `attempts`, `lastError`, `lockedUntil` (lease), `deliveredAt`, `deadLetteredAt` (set after 8 failed attempts).
- Money: integer minor units + ISO 4217 currency. Every business write adds AuditLog and (if it has external effects) Outbox.
- `Product` (tenant price list): unique (`tenantId`, `sku`), `unitAmount` in minor units, ISO `currency`, `active`. Customer orders are priced from it; an order keeps its own unit amounts, so a price change never alters existing orders.
- `Order.customerUserId` (nullable, FK to `User`, ON DELETE SET NULL): set for orders a customer created for themself; the only key customers can read by. Staff orders leave it null even when `customerEmail` matches a customer.
- `IdempotencyKey.key`: `<tenantId>:<client key>` for staff, `<tenantId>:u:<userId>:<client key>` for customer self-service.
- `User.totpSecret` (AES-256-GCM ciphertext `v1.<iv>.<tag>.<ct>`, never plaintext), `User.totpEnabledAt` (null = 2FA off or enrollment pending), `User.totpLastStep` (last accepted TOTP step; single-use codes).
- `MfaRecoveryCode`: `userId` (ON DELETE CASCADE), `codeHash` (HMAC-SHA256 under a key derived from `TOTP_ENC_KEY`), `usedAt` (set once, atomically).
