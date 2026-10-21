import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createCustomerOrder } from "../services/orders.service.js";
import { startCheckout } from "../services/checkout.service.js";
import { ordersRepo } from "../repositories/orders.repository.js";
import { requireAuth, tenantOf } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { CheckoutResponse, IdempotencyHeaders } from "./orders.js";

const OrderId = z.object({ id: z.string().min(1).max(64) });
const CustomerOrderBody = z.object({
  items: z.array(z.object({ sku: z.string().min(1).max(64), qty: z.number().int().positive().max(1_000) }).strict()).min(1).max(50),
}).strict(); // unknown fields (unitAmount, currency, customerEmail, tenantId...) are rejected, never silently trusted

/**
 * Customer self-service (role `customer` only). Every route is scoped to the caller's tenant AND to the caller's user id:
 * another customer's order, in the same tenant or another one, answers 404 exactly like a missing id (no IDOR oracle).
 * Staff keep using /orders; these routes are not for staff, so staff cannot accidentally create orders owned by themselves.
 */
export async function meRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const customer = requireAuth(["customer"]);

  r.post("/me/orders", {
    preHandler: customer,
    schema: {
      tags: ["me", "orders"],
      summary: "Customer: create a draft order for myself, priced from the tenant's products",
      description: "Send SKUs and quantities only. Unit amounts and currency come from the tenant's active products (422 UNKNOWN_SKU, MIXED_CURRENCY, DUPLICATE_SKU). The order belongs to the caller (customerEmail is the account email). Idempotent: the Idempotency-Key is scoped to the caller and bound to the body (422 IDEMPOTENCY_MISMATCH on reuse with another body).",
      body: CustomerOrderBody, headers: IdempotencyHeaders,
    },
  }, async (req, reply) => {
    const order = await createCustomerOrder(req.body, req.headers["idempotency-key"],
      { tenantId: tenantOf(req), actor: `user:${req.user!.uid}`, userId: req.user!.uid, email: req.account!.email });
    return reply.status(201).send(order);
  });

  r.get("/me/orders", {
    preHandler: customer,
    schema: {
      tags: ["me", "orders"], summary: "Customer: list my orders, newest first",
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().min(1).max(64).optional() }),
    },
  }, async (req) => {
    const rows = await ordersRepo.listForCustomer(tenantOf(req), req.user!.uid, { limit: req.query.limit, cursor: req.query.cursor });
    const hasMore = rows.length > req.query.limit;
    const items = hasMore ? rows.slice(0, req.query.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  });

  r.get("/me/orders/:id", {
    preHandler: customer,
    schema: { tags: ["me", "orders"], summary: "Customer: read one of my orders", params: OrderId },
  }, async (req) => {
    const order = await ordersRepo.byIdForCustomer(req.params.id, tenantOf(req), req.user!.uid);
    if (!order) throw notFound("Order");
    return order;
  });

  r.post("/me/orders/:id/checkout", {
    preHandler: customer,
    schema: {
      tags: ["me", "orders", "payments"],
      summary: "Customer: start payment for my order (draft -> pending_payment and a provider payment intent)",
      description: "Same state machine, provider idempotency key (checkout:<orderId>) and transaction as staff checkout. Only the caller's own orders (404 otherwise). Idempotent: same key replays; a new key on an order already in pending_payment resumes its intent.",
      params: OrderId, headers: IdempotencyHeaders, response: { 200: CheckoutResponse },
    },
  }, async (req) => startCheckout(req.params.id, req.headers["idempotency-key"], { tenantId: tenantOf(req), actor: `user:${req.user!.uid}`, customerUserId: req.user!.uid }));
}
