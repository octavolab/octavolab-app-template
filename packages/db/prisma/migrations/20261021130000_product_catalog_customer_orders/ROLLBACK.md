# Rollback plan for 20261021130000_product_catalog_customer_orders
Expand only: a new table (`Product`) and a nullable column on `Order`. The previous app version (0.6.0) ignores both, so rolling back
the app is enough. Orders created by customers keep their `customerUserId`; 0.6.0 staff routes still see them by tenant.

To remove the schema change (only with Jaime's approval, after the app is back on 0.6.0 and nothing reads these objects):
```sql
ALTER TABLE "Order" DROP CONSTRAINT "Order_customerUserId_fkey";
DROP INDEX "Order_tenantId_customerUserId_createdAt_idx";
ALTER TABLE "Order" DROP COLUMN "customerUserId";
DROP TABLE "Product";
```
Then delete the row for this migration from `_prisma_migrations` so a later deploy can re-apply it.
