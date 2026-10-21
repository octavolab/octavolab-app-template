# Resend (email)

| Item | Value |
|---|---|
| Adapter | `packages/integrations/src/resend.ts` (`ResendMessaging`, implements `MessagingProvider`) |
| API | `POST https://api.resend.com/emails` (JSON, `Authorization: Bearer <RESEND_API_KEY>`, optional `Idempotency-Key`) |
| Selected when | `MESSAGING_PROVIDER=resend` and `INTEGRATIONS_MODE` is `sandbox` or `live`. Otherwise the fake adapter (default) |
| Env | `RESEND_API_KEY` (`re_...`), `MESSAGING_FROM` (`noreply@domain` or `Name <noreply@domain>`); the API refuses to start without them in that case |
| Docs read | https://resend.com/docs/api-reference/emails/send-email and /errors (re-read on the day the key is loaded, N02) |

## Behaviour
- One HTTP attempt per send with a 10 s timeout (`AbortSignal.timeout`). Retries, backoff and dead letter belong to the outbox
  worker, so a slow provider never multiplies inside one 60 s claim lease.
- Provider idempotency: the outbox passes `outbox:<eventId>`; a retry after a timeout that actually succeeded is not sent twice
  (Resend keeps keys for 24 hours; after that a very late retry could send again, which is acceptable for ops notifications).
- Sandbox never emails real people: every recipient becomes `delivered@resend.dev` (Resend's test inbox) unless it already ends
  in `@resend.dev` (`bounced@resend.dev` and `complained@resend.dev` simulate failures). Real recipients only in `live`.
- Templates are code (`templates.ts`): data values are HTML-escaped and stripped of line breaks; an unknown template is a
  permanent error.

## Error mapping (`MessagingError`)
| Provider answer | `code` | Outbox behaviour |
|---|---|---|
| 400, 404, 422 (validation, bad idempotency key) | `rejected` | dead-letter at once (`retryable=false`) |
| 409 `invalid_idempotent_request` (same key, other payload) | `idempotency` | dead-letter at once |
| 409 `concurrent_idempotent_requests` | `idempotency` | retry with backoff |
| 401, 403 (missing or invalid key) | `auth` | retry with backoff (fixing the key lets the event go out) |
| 429 (rate limit or quota) | `rate_limited` | retry with backoff |
| 5xx, timeout, network error, 2xx without id | `provider_unavailable`, `timeout`, `network`, `bad_response` | retry with backoff |

Error messages are `resend <status> <error name>` only: never the API key, the recipient or the provider's free-text message
(which can echo the address). `lastError` on the outbox row and the worker logs therefore hold no secrets or personal data.

## Verified
- Locally and in CI: unit tests with a mocked `fetch` (`packages/integrations/src/resend.test.ts`), adapter selection, env rules.
- Only in a real run: a send with a real key to `delivered@resend.dev` (sandbox) and the sender domain verification (live).

## Operations
- Sandbox: create a Resend account key restricted to "Sending access"; send only to `@resend.dev` test addresses (the adapter enforces it).
- Live mode checklist: Jaime's approval (N07), sender domain verified in Resend (SPF, DKIM), `RESEND_API_KEY` and `MESSAGING_FROM`
  loaded as Lightsail environment variables for both the app and worker containers, first real send recorded in `docs/learnings.md`.
- Key rotation: create the new key, update the Lightsail variable, redeploy (worker picks it up), revoke the old key. Events that
  failed with 401/403 in between are retried by the outbox.
- Webhooks (delivery, bounce): not consumed yet (roadmap).
- Owner: tech lead in `OWNERSHIP.md`.
