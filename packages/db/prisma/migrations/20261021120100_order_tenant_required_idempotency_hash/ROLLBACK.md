# Rollback plan for 20261021120100_order_tenant_required_idempotency_hash
Contract step for `Order.tenantId`: the migration aborts before changing anything if an order has no tenant (backfill first).
The previous app version still works against the migrated schema while every order it writes has a tenant (v0.5.0 wrote NULL
only for users without a tenant); deploying v0.5.0 on top of this schema can fail those writes, which is the intended protection.

To revert the schema (only after the previous version is live and only if required):
```sql
ALTER TABLE "Order" DROP CONSTRAINT "Order_tenantId_fkey";
ALTER TABLE "Order" ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IdempotencyKey" DROP COLUMN "requestHash";
```
Idempotency keys stored before the migration have an empty hash: a client replaying one gets 422 IDEMPOTENCY_MISMATCH and must use a new key. No duplicate order can result.
