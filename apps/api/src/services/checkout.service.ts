import { prisma, Prisma } from "@octavolab/db";
import { getPayments, type PaymentGateway } from "@octavolab/integrations";
import { ordersRepo } from "../repositories/orders.repository.js";
import { idempotencyRepo } from "../repositories/idempotency.repository.js";
import { auditRepo } from "../repositories/audit.repository.js";
import { canTransition, type OrderStatus } from "../lib/order-state.js";
import { requestHash } from "../lib/canonical.js";
import { AppError, conflict, notFound } from "../lib/errors.js";
import type { Ctx } from "./orders.service.js";

export type CheckoutResult = { orderId: string; status: "pending_payment"; paymentIntentId: string; amount: number; currency: string; clientSecret?: string | undefined };

/**
 * Starts payment for an order (draft or confirmed -> pending_payment) and creates the provider payment intent.
 *
 * Order of effects: the intent is created first with a provider idempotency key derived from the order
 * (`checkout:<orderId>`), then ONE transaction moves the order (optimistic on version), stores the intent id, writes
 * the audit entry and the Idempotency-Key record. If the transaction fails, a retry reaches the same provider intent,
 * so no second intent or charge can exist for the order. The signed webhook later moves pending_payment -> paid.
 *
 * Idempotent three ways: the same Idempotency-Key and body replays the stored result (422 with another body); a new
 * key for an order already in pending_payment resumes the existing intent; any other state returns 409.
 * The client secret is never stored by us: it is re-read from the provider when a checkout is replayed or resumed.
 */
export async function startCheckout(orderId: string, idempotencyKey: string, ctx: Ctx, payments: PaymentGateway = getPayments()): Promise<CheckoutResult> {
  if (!ctx.tenantId) throw new AppError("TENANT_REQUIRED", "This action requires a tenant", 403);
  const key = idempotencyRepo.scopedKey(ctx.tenantId, idempotencyKey);
  const hash = requestHash("orders.checkout", { orderId });
  const replay = await idempotencyRepo.find(key, hash);
  if (replay) return resume(JSON.parse(replay.response) as CheckoutResult, payments);

  const order = await ordersRepo.byIdForTenant(orderId, ctx.tenantId);
  if (!order) throw notFound("Order");
  if (order.status === "pending_payment" && order.paymentIntentId) {
    return resume({ orderId: order.id, status: "pending_payment", paymentIntentId: order.paymentIntentId, amount: order.totalAmount, currency: order.currency }, payments);
  }
  const status = order.status as OrderStatus;
  if (!canTransition(status, "pending_payment")) throw new AppError("INVALID_STATE", `An order in status ${status} cannot start checkout`, 409);
  // Money is an integer in minor units with an ISO 4217 currency; a zero or malformed total cannot be charged.
  if (!Number.isSafeInteger(order.totalAmount) || order.totalAmount <= 0 || !/^[A-Z]{3}$/.test(order.currency)) {
    throw new AppError("AMOUNT_INVALID", "Order total must be a positive integer in minor units with an ISO currency", 422);
  }

  const intent = await payments.createPaymentIntent({ orderId: order.id, money: { amount: order.totalAmount, currency: order.currency }, idempotencyKey: `checkout:${order.id}` });
  const result: CheckoutResult = { orderId: order.id, status: "pending_payment", paymentIntentId: intent.providerRef, amount: order.totalAmount, currency: order.currency };
  try {
    await prisma.$transaction(async (tx) => {
      const moved = await ordersRepo.transition(tx, order.id, [status], "pending_payment", order.version, { paymentIntentId: intent.providerRef });
      if (!moved) throw conflict("Order changed while starting checkout; retry");
      await auditRepo.record({ entity: "Order", entityId: order.id, action: "checkout_started", actor: ctx.actor, before: { status }, after: { status: "pending_payment", paymentIntentId: intent.providerRef, provider: payments.name } }, tx);
      await idempotencyRepo.save(tx, key, hash, result);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("duplicate request");
    throw e;
  }
  return { ...result, clientSecret: intent.clientSecret };
}

async function resume(stored: CheckoutResult, payments: PaymentGateway): Promise<CheckoutResult> {
  const intent = await payments.retrievePaymentIntent(stored.paymentIntentId);
  return { ...stored, clientSecret: intent.clientSecret };
}
