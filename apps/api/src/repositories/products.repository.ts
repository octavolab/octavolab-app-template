import { prisma, Prisma } from "@octavolab/db";

type Tx = Prisma.TransactionClient;
export type ProductInput = { sku: string; name: string; unitAmount: number; currency: string; active: boolean };

export const productsRepo = {
  /** Active products of one tenant with the given SKUs (prices for customer self-service orders). */
  activeBySkus: (tenantId: string, skus: string[]) =>
    prisma.product.findMany({ where: { tenantId, sku: { in: skus }, active: true } }),

  /** Tenant price list, ordered by SKU. `includeInactive` is for staff only. */
  list: (tenantId: string, includeInactive: boolean) =>
    prisma.product.findMany({ where: { tenantId, ...(includeInactive ? {} : { active: true }) }, orderBy: { sku: "asc" }, take: 500 }),

  bySku: (tenantId: string, sku: string, db: Tx | typeof prisma = prisma) =>
    db.product.findUnique({ where: { tenantId_sku: { tenantId, sku } } }),

  /** Create or replace a product by (tenant, sku): a natural key, so the write is idempotent without an Idempotency-Key. */
  upsert: (tx: Tx, tenantId: string, p: ProductInput) =>
    tx.product.upsert({ where: { tenantId_sku: { tenantId, sku: p.sku } }, create: { tenantId, ...p }, update: { name: p.name, unitAmount: p.unitAmount, currency: p.currency, active: p.active } }),
};
