import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createOrder } from "../services/orders.service.js";
import { ordersRepo } from "../repositories/orders.repository.js";
import { requireAuth, tenantOf } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";

const CreateOrder = z.object({
  customerEmail: z.string().email(),
  currency: z.enum(["USD", "GBP", "EUR", "COP", "MXN", "BRL"]),
  items: z.array(z.object({ sku: z.string().min(1).max(64), qty: z.number().int().positive().max(10_000), unitAmount: z.number().int().nonnegative() })).min(1).max(200),
});

export async function orderRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/orders", {
    preHandler: requireAuth(["owner", "admin", "operations"]),
    schema: { tags: ["orders"], body: CreateOrder, headers: z.object({ "idempotency-key": z.string().min(8).max(128) }) },
  }, async (req, reply) => {
    const order = await createOrder(req.body, req.headers["idempotency-key"], { tenantId: tenantOf(req), actor: `user:${req.user!.uid}` });
    return reply.status(201).send(order);
  });

  r.get("/orders/:id", {
    preHandler: requireAuth(["owner", "admin", "operations"]), // staff only: a customer would otherwise read other customers' orders in the same tenant
    schema: { tags: ["orders"], params: z.object({ id: z.string().min(1).max(64) }) },
  }, async (req) => {
    const order = await ordersRepo.byIdForTenant(req.params.id, tenantOf(req));
    if (!order) throw notFound("Order");
    return order;
  });
}
