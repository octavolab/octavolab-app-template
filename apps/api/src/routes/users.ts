import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { changeUserRole } from "../services/users.service.js";
import { requireAuth, tenantOf } from "../lib/auth.js";

export async function userRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Owner-only role change inside the owner's tenant; revokes the target's sessions (sessionVersion + 1).
  r.patch("/users/:id/role", {
    preHandler: requireAuth(["owner"]),
    schema: { tags: ["users"], params: z.object({ id: z.string().min(1).max(64) }), body: z.object({ role: z.enum(["owner", "admin", "operations", "customer"]) }) },
  }, async (req) => changeUserRole(req.params.id, req.body.role, { tenantId: tenantOf(req), actorId: req.user!.uid }));
}
