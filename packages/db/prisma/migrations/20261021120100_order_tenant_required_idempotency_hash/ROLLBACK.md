# Rollback plan for 20261021120100_order_tenant_required_idempotency_hash
Contract step for `Order.tenantId`: the migration aborts before changing anything if an order has no tenant (backfill first).

Running the previous app version (v0.5.0) on the migrated schema:
- Order creation by users WITH a tenant keeps working. `IdempotencyKey.requestHash` has a `''` default, so v0.5.0 inserts succeed.
- Order creation by users WITHOUT a tenant fails with a NOT NULL violation (500). That is the defect this migration closes; accept it
  during the rollback window or revert the schema below.

To revert the schema (only after the previous version is live and only if required):
```sql
ALTER TABLE "Order" DROP CONSTRAINT "Order_tenantId_fkey";
ALTER TABLE "Order" ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IdempotencyKey" DROP COLUMN "requestHash";
```
Idempotency keys stored with an empty hash (before the migration or by v0.5.0): a client replaying one gets 422 IDEMPOTENCY_MISMATCH and
must use a new key. No duplicate order can result.
