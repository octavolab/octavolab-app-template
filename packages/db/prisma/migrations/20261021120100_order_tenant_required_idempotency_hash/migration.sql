-- 1) Order.tenantId becomes NOT NULL: a NULL tenant acted as a shared tenant across users without one.
-- 2) IdempotencyKey.requestHash binds a key to the request that created it (422 IDEMPOTENCY_MISMATCH on reuse with another body).
-- Written by hand from schema.prisma (Prisma engine download blocked in the authoring environment); CI checks drift with
-- `prisma migrate diff --exit-code`.

-- Guard: refuse to run (and leave the schema untouched) if orders without a tenant exist. Assign them first, e.g.
-- UPDATE "Order" SET "tenantId" = '<tenant id>' WHERE "tenantId" IS NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Order" WHERE "tenantId" IS NULL) THEN
    RAISE EXCEPTION 'Order rows with NULL "tenantId" exist; assign them to a tenant before applying this migration (see ROLLBACK.md)';
  END IF;
END $$;

-- DropForeignKey (was ON DELETE SET NULL, impossible for a required column)
ALTER TABLE "Order" DROP CONSTRAINT "Order_tenantId_fkey";

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "tenantId" SET NOT NULL;

-- AddForeignKey (Prisma default for a required relation)
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: existing keys get an empty hash, which never matches a real request hash, so replaying a key created
-- before this migration returns 422 instead of a possibly different stored response.
ALTER TABLE "IdempotencyKey" ADD COLUMN "requestHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "IdempotencyKey" ALTER COLUMN "requestHash" DROP DEFAULT;
