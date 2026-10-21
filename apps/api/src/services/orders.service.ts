import { prisma, Prisma } from "@octavolab/db";
import { AppError, conflict } from "../lib/errors.js";
import { requestHash } from "../lib/canonical.js";
import { idempotencyRepo } from "../repositories/idempotency.repository.js";

type Input = { customerEmail: string; currency: string; items: { sku: string; qty: number; unitAmount: number }[] };

/** Every order belongs to exactly one tenant: there is no shared or "null" tenant. */
export type Ctx = { tenantId: string; actor: string };

/**
 * Transactional + idempotent order creation (Módulo C, sección 4):
 * one transaction writes order, items, audit log, outbox event and the idempotency record.
 * The same Idempotency-Key with the same body returns the same order; with a different body it is rejected (422).
 */
export async function createOrder(input: Input, idempotencyKey: string, ctx: Ctx) {
  if (!ctx.tenantId) throw new AppError("TENANT_REQUIRED", "This action requires a tenant", 403);
  const key = idempotencyRepo.scopedKey(ctx.tenantId, idempotencyKey);
  const hash = requestHash("orders.create", input);
  const replay = await idempotencyRepo.find(key, hash);
  if (replay) return JSON.parse(replay.response);

  const total = input.items.reduce((s, i) => s + i.qty * i.unitAmount, 0);
  if (!Number.isSafeInteger(total) || total > 2_147_483_647) throw new AppError("AMOUNT_RANGE", "total exceeds the 32-bit minor-unit column; see ADR to move totalAmount to BigInt", 422);
  try {
    return await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: { tenantId: ctx.tenantId, customerEmail: input.customerEmail, currency: input.currency, totalAmount: total, status: "draft",
          items: { create: input.items.map((i) => ({ sku: i.sku, qty: i.qty, unitAmount: i.unitAmount })) } },
        include: { items: true },
      });
      await tx.auditLog.create({ data: { entity: "Order", entityId: order.id, action: "create", actor: ctx.actor, after: order as unknown as Prisma.InputJsonValue } });
      await tx.outbox.create({ data: { type: "order.created", payload: { orderId: order.id } } });
      await idempotencyRepo.save(tx, key, hash, order);
      return order;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("duplicate request");
    throw e;
  }
}
