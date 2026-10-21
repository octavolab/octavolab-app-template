import { prisma, Prisma } from "@octavolab/db";
import { AppError, conflict } from "../lib/errors.js";
import { requestHash } from "../lib/canonical.js";
import { idempotencyRepo } from "../repositories/idempotency.repository.js";
import { productsRepo } from "../repositories/products.repository.js";

type Input = { customerEmail: string; currency: string; items: { sku: string; qty: number; unitAmount: number }[] };

/** Every order belongs to exactly one tenant: there is no shared or "null" tenant. */
export type Ctx = { tenantId: string; actor: string };

/** A customer acting for themself: the order is owned by `userId`, and its Idempotency-Key is scoped to that customer. */
export type CustomerCtx = Ctx & { userId: string; email: string };

/** What a customer may send: SKUs and quantities only. Prices and currency always come from the tenant's Product table. */
export type CustomerOrderInput = { items: { sku: string; qty: number }[] };

const MAX_TOTAL = 2_147_483_647;

/**
 * Transactional + idempotent order creation by staff (Módulo C, sección 4):
 * one transaction writes order, items, audit log, outbox event and the idempotency record.
 * The same Idempotency-Key with the same body returns the same order; with a different body it is rejected (422).
 */
export async function createOrder(input: Input, idempotencyKey: string, ctx: Ctx) {
  if (!ctx.tenantId) throw new AppError("TENANT_REQUIRED", "This action requires a tenant", 403);
  const key = idempotencyRepo.scopedKey(ctx.tenantId, idempotencyKey);
  const hash = requestHash("orders.create", input);
  const replay = await idempotencyRepo.find(key, hash);
  if (replay) return JSON.parse(replay.response);
  return persistOrder(input, { key, hash }, ctx, null);
}

/**
 * Customer self-service order (POST /me/orders). The Idempotency-Key is bound to the body the customer sent (SKUs and
 * quantities), checked BEFORE pricing, so a retry replays the original order even if a price changed in between.
 * Prices come from the tenant's active products; an unknown or inactive SKU, or SKUs in different currencies, is 422.
 * The order is created for the caller only: owner = caller's user id, customerEmail = caller's account email.
 */
export async function createCustomerOrder(input: CustomerOrderInput, idempotencyKey: string, ctx: CustomerCtx) {
  if (!ctx.tenantId) throw new AppError("TENANT_REQUIRED", "This action requires a tenant", 403);
  const key = idempotencyRepo.scopedKey(ctx.tenantId, idempotencyKey, ctx.userId);
  const hash = requestHash("me.orders.create", input);
  const replay = await idempotencyRepo.find(key, hash);
  if (replay) return JSON.parse(replay.response);

  const skus = [...new Set(input.items.map((i) => i.sku))];
  if (skus.length !== input.items.length) throw new AppError("DUPLICATE_SKU", "Each SKU may appear once; use qty", 422);
  const products: { sku: string; unitAmount: number; currency: string }[] = await productsRepo.activeBySkus(ctx.tenantId, skus);
  const bySku = new Map(products.map((p) => [p.sku, p] as const));
  const missing = skus.filter((s) => !bySku.has(s));
  if (missing.length) throw new AppError("UNKNOWN_SKU", `Unknown or unavailable SKU: ${missing.slice(0, 5).join(", ")}`, 422);
  const currencies = new Set(products.map((p) => p.currency));
  if (currencies.size !== 1) throw new AppError("MIXED_CURRENCY", "All items of one order must share a currency", 422);

  const priced: Input = {
    customerEmail: ctx.email,
    currency: [...currencies][0]!,
    items: input.items.map((i) => ({ sku: i.sku, qty: i.qty, unitAmount: bySku.get(i.sku)!.unitAmount })),
  };
  return persistOrder(priced, { key, hash }, ctx, ctx.userId);
}

/** The single write path for orders: order + items, audit, outbox and idempotency record in ONE transaction. */
async function persistOrder(input: Input, idem: { key: string; hash: string }, ctx: Ctx, customerUserId: string | null) {
  const total = input.items.reduce((s, i) => s + i.qty * i.unitAmount, 0);
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL) throw new AppError("AMOUNT_RANGE", "total exceeds the 32-bit minor-unit column; see ADR to move totalAmount to BigInt", 422);
  try {
    return await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: { tenantId: ctx.tenantId, customerEmail: input.customerEmail, currency: input.currency, totalAmount: total, status: "draft",
          ...(customerUserId ? { customerUserId } : {}),
          items: { create: input.items.map((i) => ({ sku: i.sku, qty: i.qty, unitAmount: i.unitAmount })) } },
        include: { items: true },
      });
      await tx.auditLog.create({ data: { entity: "Order", entityId: order.id, action: "create", actor: ctx.actor, after: order as unknown as Prisma.InputJsonValue } });
      await tx.outbox.create({ data: { type: "order.created", payload: { orderId: order.id } } });
      await idempotencyRepo.save(tx, idem.key, idem.hash, order);
      return order;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("duplicate request");
    throw e;
  }
}
