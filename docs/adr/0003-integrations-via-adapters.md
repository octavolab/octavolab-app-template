# ADR 0003: Integrations behind domain adapters
Date: 2026-10-21 · Status: accepted
Decision: business code depends on PaymentGateway, CarrierRates, MessagingProvider interfaces; providers are adapters selected by env; a fake adapter always exists. INTEGRATIONS_MODE=live only with approval. Consequences: provider swap without touching business logic; demos never hit real providers.
