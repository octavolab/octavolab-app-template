# Data model
See packages/db/prisma/schema.prisma. Order states: draft → confirmed → paid → shipped → delivered → closed; cancelled, refunded. Money: integer minor units + currency. Every business write adds AuditLog and (if it has external effects) Outbox.
