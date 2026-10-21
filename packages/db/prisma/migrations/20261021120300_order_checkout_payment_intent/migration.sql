-- Checkout: new order state pending_payment and the provider payment intent id on the order.
-- Written by hand from schema.prisma (Prisma engine download blocked in the authoring environment); CI checks drift with
-- `prisma migrate diff --exit-code`.

-- AlterEnum (PostgreSQL 12+ allows ADD VALUE inside a transaction; the value is not used in this migration)
ALTER TYPE "OrderStatus" ADD VALUE 'pending_payment' AFTER 'confirmed';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "paymentIntentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_paymentIntentId_key" ON "Order"("paymentIntentId");
