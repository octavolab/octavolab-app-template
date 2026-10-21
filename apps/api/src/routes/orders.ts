import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createOrder } from "../services/orders.service.js";

const CreateOrder = z.object({
  customerEmail: z.string().email(),
  currency: z.enum(["USD", "GBP", "EUR", "COP", "MXN", "BRL"]),
  items: z.array(z.object({ sku: z.string().min(1), qty: z.number().int().positive(), unitAmount: z.number().int().nonnegative() })).min(1),
});

export async function orderRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().post("/orders", {
    schema: { body: CreateOrder, headers: z.object({ "idempotency-key": z.string().min(8) }) },
  }, async (req, reply) => {
    const order = await createOrder(req.body, req.headers["idempotency-key"]);
    return reply.status(201).send(order);
  });
}
