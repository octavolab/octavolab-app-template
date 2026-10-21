import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { upsertProduct } from "../services/products.service.js";
import { productsRepo } from "../repositories/products.repository.js";
import { requireAuth, tenantOf } from "../lib/auth.js";
import { Currency } from "./orders.js";

const STAFF = ["owner", "admin", "operations"] as const;

/** Tenant price list: managed by owner and admin, readable by every signed-in user of the tenant (customers see active products only). */
export async function productRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/products", {
    preHandler: requireAuth(),
    schema: { tags: ["products"], summary: "List the tenant's products (staff also see inactive ones)" },
  }, async (req) => ({ items: await productsRepo.list(tenantOf(req), (STAFF as readonly string[]).includes(req.user!.role)) }));

  r.put("/products/:sku", {
    preHandler: requireAuth(["owner", "admin"]),
    schema: {
      tags: ["products"], summary: "Create or update a product by SKU (owner, admin); audited",
      params: z.object({ sku: z.string().min(1).max(64).regex(/^[\w.-]+$/) }),
      body: z.object({ name: z.string().min(1).max(200), unitAmount: z.number().int().positive().max(2_147_483_647), currency: Currency, active: z.boolean().default(true) }),
    },
  }, async (req) => upsertProduct({ sku: req.params.sku, ...req.body }, { tenantId: tenantOf(req), actor: `user:${req.user!.uid}` }));
}
