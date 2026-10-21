# ADR 0002: Transactional outbox for external effects
Date: 2026-10-21 · Status: accepted
Context: emails, webhooks and provider calls must not run inside DB transactions. Decision: write an Outbox row in the same transaction; a worker delivers with exponential retries; incoming webhooks are deduplicated by provider event id. Consequences: at-least-once delivery, so handlers are idempotent.
