import { prisma } from "@octavolab/db";
import { usersRepo } from "../repositories/users.repository.js";
import { auditRepo } from "../repositories/audit.repository.js";
import { AppError, notFound } from "../lib/errors.js";
import type { Session } from "../lib/session.js";

/** Role change inside the actor's tenant. The same transaction revokes the target's sessions and writes the audit entry. */
export async function changeUserRole(targetId: string, role: Session["role"], ctx: { tenantId: string; actorId: string }) {
  if (targetId === ctx.actorId) throw new AppError("SELF_ROLE_CHANGE", "Owners cannot change their own role", 409);
  const before = await usersRepo.byId(targetId);
  if (!before || before.tenantId !== ctx.tenantId) throw notFound("User");
  await prisma.$transaction(async (tx) => {
    if (!(await usersRepo.changeRole(tx, before.id, ctx.tenantId, role))) throw notFound("User");
    await auditRepo.record({ entity: "User", entityId: before.id, action: "role_change", actor: `user:${ctx.actorId}`, before: { role: before.role }, after: { role } }, tx);
  });
  return { id: before.id, role };
}
