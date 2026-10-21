# ADR 0004: TOTP 2FA without a dependency; customer self-service priced from a catalog
Date: 2026-10-22 · Status: accepted

Decision 1 (2FA): TOTP (RFC 6238) implemented on `node:crypto` (about 80 lines, tested against the RFC 6238 and RFC 4226 vectors) instead of otplib, to avoid a supply-chain dependency in the authentication path. Secrets are AES-256-GCM ciphertext under an HKDF sub-key of `TOTP_ENC_KEY` (environment only), bound to the user id; recovery codes are keyed HMAC-SHA256. The second login step uses a purpose-signed 5-minute cookie, never a partial session. Owners can be forced to enroll (`REQUIRE_OWNER_2FA`). Consequences: no new package to audit; key loss or rotation forces re-enrollment (runbook); TOTP is phishable, so WebAuthn stays on the roadmap.

Decision 2 (self-service): customers get their own routes (`/me/orders`) instead of widening `/orders`. Ownership is a column (`Order.customerUserId`), not the email, and every customer query filters by tenant and owner. Customers send SKUs and quantities only; prices come from a tenant `Product` table. Checkout reuses `startCheckout` with a customer context. Consequences: no IDOR through shared routes, no client-controlled prices; staff tooling is unchanged; a catalog must exist before customers can order (seed and `PUT /products/:sku`).

Decision 3 (messaging): one HTTP attempt per send with a timeout; retries, backoff and dead letter stay in the outbox, which passes `outbox:<eventId>` as the provider idempotency key. Errors carry a `retryable` flag so request errors are dead-lettered at once.
