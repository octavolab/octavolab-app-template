# Integrations
One file per provider: purpose, official docs URL and date read, sandbox setup, webhooks, key rotation, owner. Template: `docs/integrations/_template.md`.

| Integration | Mode variable | Provider variable | Adapter | Doc |
|---|---|---|---|---|
| Payments | `PAYMENTS_MODE` | `PAYMENTS_PROVIDER=stripe` | `stripe.ts` | [stripe.md](stripe.md) |
| Messaging (email) | `MESSAGING_MODE` | `MESSAGING_PROVIDER=resend` | `resend.ts` | [resend.md](resend.md) |
| Carrier rates | `CARRIER_MODE` | `CARRIER_PROVIDER=oes` | `oes.ts` (wire format pending the OES spec) | [oes.md](oes.md) |
| File storage | `STORAGE_MODE` | `STORAGE_PROVIDER=s3` | `storage.ts` (Lightsail bucket) | [storage.md](storage.md) |
| Error tracking | `SENTRY_DSN` set or not | n/a | `apps/api/src/lib/sentry.ts`, `apps/web/src/sentry.ts` | [sentry.md](sentry.md) |

## Modes (ADR 0005)
- Each mode is `fake | sandbox | live` and defaults to `INTEGRATIONS_MODE`, then to `fake` outside production. In production
  every mode must resolve explicitly; the API and the worker refuse to start otherwise.
- `fake`: in-process adapter, no network. `sandbox`: the real provider with test credentials. `live`: real money, real
  messages; requires `ALLOW_LIVE=true`, which is only accepted with `APP_ENV=production` and only after Jaime's approval (N07).
- Every provider secret is validated at boot for the mode it is used in (e.g. a live Stripe key in sandbox is refused).
- `GET /api/health` shows `modes` and `deps.payments` (`ok | degraded`, cached 60 s).

## Staging target (2026-10-22)
| Integration | Staging mode | Why |
|---|---|---|
| Payments | `sandbox` | Stripe test mode |
| Messaging | `sandbox` | Resend, `delivered@resend.dev` plus `MESSAGING_ALLOW_LIST` |
| Carrier | `fake` | until the OES spec and sandbox keys arrive (TODO(OES-SPEC)) |
| Storage | `sandbox` once the bucket and its access key exist, `fake` until then | Lightsail bucket |
