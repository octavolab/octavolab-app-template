import type { FastifyInstance } from "fastify";
import { prisma, Prisma } from "@octavolab/db";
import { getPayments } from "@octavolab/integrations";
import { ordersRepo } from "../repositories/orders.repository.js";
import { sourcesOf } from "../lib/order-state.js";
import { AppError } from "../lib/errors.js";
import { env } from "../config/env.js";

/**
 * Payment provider webhooks (Módulo C 4.4): signature verified on the raw body, deduplicated by provider event id,
 * state change + audit + outbox in one transaction, fast 2xx. Unknown event types are acknowledged and ignored.
 */
export async function webhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/payments", async (req, reply) => {
    if (getPayments().name === "fake-payments" && env.NODE_ENV === "production") throw new AppError("NOT_FOUND", "route not found", 404); // the fake adapter accepts unsigned events
    const raw = req.body as string;
    const signature = (req.headers["stripe-signature"] as string | undefined) ?? (req.headers["x-signature"] as string | undefined) ?? "";
    let event: { eventId: string; type: string; data: unknown };
    try {
      event = await getPayments().verifyWebhook(raw, signature);
    } catch {
      throw new AppError("BAD_SIGNATURE", "Invalid webhook signature", 400);
    }

    type IntentObject = { id?: string; status?: string; amount?: number; amount_received?: number; currency?: string; metadata?: { orderId?: string } };
    const obj = (event.data as { object?: IntentObject } | undefined)?.object;
    const isPaid = event.type === "payment_intent.succeeded" || event.type === "payment.succeeded";

    // Event record, state change, audit and outbox commit together: if anything fails, nothing is recorded and the
    // provider's retry is processed again; a duplicate delivery hits the unique id and is acknowledged without effects.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.webhookEvent.create({ data: { id: event.eventId, provider: getPayments().name, payload: event.data as Prisma.InputJsonValue } });
        if (!isPaid || !obj?.metadata?.orderId) return;
        const order = await tx.order.findUnique({ where: { id: obj.metadata.orderId } });
        if (!order) return;
        // Paid only if the provider says the intent succeeded AND the amount actually received, the amount and the currency
        // match the order, AND (when checkout stored one) it is the intent created for this order.
        const amountOk = obj.status === "succeeded"
          && obj.amount_received === order.totalAmount
          && (obj.amount === undefined || obj.amount === order.totalAmount)
          && String(obj.currency ?? "").toUpperCase() === order.currency
          && (!order.paymentIntentId || obj.id === order.paymentIntentId);
        if (!amountOk) {
          await tx.auditLog.create({ data: { entity: "Order", entityId: order.id, action: "payment_mismatch", actor: `webhook:${event.eventId}`,
            after: { intent: obj.id ?? null, status: obj.status ?? null, amount: obj.amount ?? null, amountReceived: obj.amount_received ?? null, currency: obj.currency ?? null,
              expected: { intent: order.paymentIntentId ?? null, amount: order.totalAmount, currency: order.currency } } } });
          return;
        }
        const moved = await ordersRepo.transition(tx, order.id, sourcesOf("paid"), "paid", order.version);
        if (!moved) return; // already paid or not payable: idempotent no-op
        await tx.auditLog.create({ data: { entity: "Order", entityId: order.id, action: "paid", actor: `webhook:${event.eventId}`, before: { status: order.status }, after: { status: "paid" } } });
        await tx.outbox.create({ data: { type: "order.paid", payload: { orderId: order.id } } });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return reply.code(200).send({ ok: true, duplicate: true });
      throw e;
    }
    return reply.code(200).send({ ok: true });
  });
}
