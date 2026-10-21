# ADR 0001: Stack
Date: 2026-10-21 · Status: accepted
Context: group standard (Módulo S, section 2). Decision: TypeScript everywhere; Fastify + Prisma + PostgreSQL 16 + Redis/BullMQ (BullMQ declared as dependency, not used yet; the outbox worker polls the database); React + Vite + Tailwind v4; Lightsail container service. Consequences: one language for a 3 to 4 person team; SSR via Next.js only when SEO requires it (new ADR).
