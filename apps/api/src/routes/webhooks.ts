import type { FastifyInstance } from "fastify";
import { prisma, Prisma } from "@octavolab/db";
import { getPayments } from "@octavolab/integrations";
import { ordersRepo } from "../repositories/orders.repository.js";
import { sourcesOf } from "../lib/order-state.js";
import { AppError } from "../lib/errors.js";

/**
 * Payment provider webhooks (Módulo C 4.4): signature verified on the raw body, deduplicated by provider event id,
 * state change + audit + outbox in one transaction, fast 2xx. Unknown event types are acknowledged and ignored.
 */
export async function webhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/payments", async (req, reply) => {
    const raw = req.body as string;
    const signature = (req.headers["stripe-signature"] as string | undefined) ?? (req.headers["x-signature"] as string | undefined) ?? "";
    let event: { eventId: string; type: string; data: unknown };
    try {
      event = await getPayments().verifyWebhook(raw, signature);
    } catch {
      throw new AppError("BAD_SIGNATURE", "Invalid webhook signature", 400);
    }

    try {
      await prisma.webhookEvent.create({ data: { id: event.eventId, provider: getPayments().name, payload: event.data as Prisma.InputJsonValue } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return reply.code(200).send({ ok: true, duplicate: true });
      throw e;
    }

    if (event.type === "payment_intent.succeeded" || event.type === "payment.succeeded") {
      const orderId = (event.data as { object?: { metadata?: { orderId?: string } } })?.object?.metadata?.orderId;
      if (orderId) {
        await prisma.$transaction(async (tx) => {
          const order = await tx.order.findUnique({ where: { id: orderId } });
          if (!order) return;
          const moved = await ordersRepo.transition(tx, order.id, sourcesOf("paid"), "paid", order.version);
          if (!moved) return; // already paid or in a state that cannot become paid: idempotent no-op, audited below only on change
          await tx.auditLog.create({ data: { entity: "Order", entityId: order.id, action: "paid", actor: `webhook:${event.eventId}`, before: { status: order.status }, after: { status: "paid" } } });
          await tx.outbox.create({ data: { type: "order.paid", payload: { orderId: order.id } } });
        });
      }
    }
    return reply.code(200).send({ ok: true });
  });
}
