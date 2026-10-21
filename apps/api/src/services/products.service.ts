import { prisma, Prisma } from "@octavolab/db";
import { productsRepo, type ProductInput } from "../repositories/products.repository.js";
import { auditRepo } from "../repositories/audit.repository.js";
import { AppError } from "../lib/errors.js";

/**
 * Create or update one product of the caller's tenant (owner or admin). Natural key (tenant, sku): repeating the same
 * request leaves the same row, so no Idempotency-Key is needed. The before and after values are audited in the same
 * transaction. Price changes never touch existing orders: an order stores its own unit amounts.
 */
export async function upsertProduct(input: ProductInput, ctx: { tenantId: string; actor: string }) {
  if (!ctx.tenantId) throw new AppError("TENANT_REQUIRED", "This action requires a tenant", 403);
  return prisma.$transaction(async (tx) => {
    const before = await productsRepo.bySku(ctx.tenantId, input.sku, tx);
    const after = await productsRepo.upsert(tx, ctx.tenantId, input);
    await auditRepo.record({
      entity: "Product", entityId: after.id, action: before ? "update" : "create", actor: ctx.actor,
      ...(before ? { before: snapshot(before) } : {}), after: snapshot(after),
    }, tx);
    return after;
  });
}

const snapshot = (p: { sku: string; name: string; unitAmount: number; currency: string; active: boolean }): Prisma.InputJsonValue =>
  ({ sku: p.sku, name: p.name, unitAmount: p.unitAmount, currency: p.currency, active: p.active });
