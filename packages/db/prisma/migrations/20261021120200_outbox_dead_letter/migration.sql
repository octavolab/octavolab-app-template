-- Outbox dead-letter state: events that reach the maximum number of attempts are parked with deadLetteredAt set.
-- Written by hand from schema.prisma (Prisma engine download blocked in the authoring environment); CI checks drift with
-- `prisma migrate diff --exit-code`.

-- AlterTable
ALTER TABLE "Outbox" ADD COLUMN "deadLetteredAt" TIMESTAMP(3);
