import { prisma, Prisma } from "@octavolab/db";
import { AppError, conflict } from "../lib/errors.js";

type Input = { customerEmail: string; currency: string; items: { sku: string; qty: number; unitAmount: number }[] };

/**
 * Transactional + idempotent order creation (Módulo C, sección 4):
 * one transaction writes order, items, audit log and outbox event; the same Idempotency-Key returns the same order.
 */
export type Ctx = { tenantId: string | null; actor: string };

export async function createOrder(input: Input, idempotencyKey: string, ctx: Ctx = { tenantId: null, actor: "api" }) {
  // Keys are scoped by tenant so one tenant can never replay (or read) another tenant's response.
  const scopedKey = `${ctx.tenantId ?? "-"}:${idempotencyKey}`;
  const existing = await prisma.idempotencyKey.findUnique({ where: { key: scopedKey } });
  if (existing) return JSON.parse(existing.response);

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
      await tx.idempotencyKey.create({ data: { key: scopedKey, response: JSON.stringify(order) } });
      return order;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("duplicate request");
    throw e;
  }
}
