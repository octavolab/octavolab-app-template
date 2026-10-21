import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createOrder } from "../services/orders.service.js";
import { startCheckout } from "../services/checkout.service.js";
import { ordersRepo } from "../repositories/orders.repository.js";
import { requireAuth, tenantOf } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";

export const Currency = z.enum(["USD", "GBP", "EUR", "COP", "MXN", "BRL"]);
export const IdempotencyHeaders = z.object({ "idempotency-key": z.string().min(8).max(128) });
export const CheckoutResponse = z.object({ orderId: z.string(), status: z.literal("pending_payment"), paymentIntentId: z.string(), amount: z.number().int(), currency: z.string().length(3), clientSecret: z.string().optional() });

const CreateOrder = z.object({
  customerEmail: z.string().email(),
  currency: Currency,
  items: z.array(z.object({ sku: z.string().min(1).max(64), qty: z.number().int().positive().max(10_000), unitAmount: z.number().int().nonnegative() })).min(1).max(200),
});

export async function orderRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/orders", {
    preHandler: requireAuth(["owner", "admin", "operations"]),
    schema: { tags: ["orders"], body: CreateOrder, headers: IdempotencyHeaders },
  }, async (req, reply) => {
    const order = await createOrder(req.body, req.headers["idempotency-key"], { tenantId: tenantOf(req), actor: `user:${req.user!.uid}` });
    return reply.status(201).send(order);
  });

  r.get("/orders/:id", {
    preHandler: requireAuth(["owner", "admin", "operations"]), // staff only: customers read their own orders through /me/orders
    schema: { tags: ["orders"], params: z.object({ id: z.string().min(1).max(64) }) },
  }, async (req) => {
    const order = await ordersRepo.byIdForTenant(req.params.id, tenantOf(req));
    if (!order) throw notFound("Order");
    return order;
  });

  r.post("/orders/:id/checkout", {
    preHandler: requireAuth(["owner", "admin", "operations"]),
    schema: {
      tags: ["orders", "payments"],
      summary: "Start payment: draft or confirmed -> pending_payment and a provider payment intent",
      description: "Idempotent: the same Idempotency-Key replays the result (422 if reused for another request); an order already in pending_payment returns its existing intent. The signed payments webhook moves the order to paid. Amounts are integers in minor units with an ISO 4217 currency.",
      params: z.object({ id: z.string().min(1).max(64) }),
      headers: IdempotencyHeaders,
      response: { 200: CheckoutResponse },
    },
  }, async (req) => startCheckout(req.params.id, req.headers["idempotency-key"], { tenantId: tenantOf(req), actor: `user:${req.user!.uid}` }));
}
