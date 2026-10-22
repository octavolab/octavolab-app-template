# ADR 0003: Integrations behind domain adapters
Date: 2026-10-21 · Status: accepted
Decision: business code depends on PaymentGateway, CarrierRates, MessagingProvider interfaces; providers are adapters selected by env; a fake adapter always exists. INTEGRATIONS_MODE=live only with approval. Consequences: provider swap without touching business logic; demos never hit real providers.
Amended by ADR 0005 (2026-10-22): one mode per integration (`PAYMENTS_MODE`, `MESSAGING_MODE`, `CARRIER_MODE`, `STORAGE_MODE`, each defaulting to `INTEGRATIONS_MODE`) and `live` gated by `ALLOW_LIVE=true`.
