import { prisma, Prisma } from "@octavolab/db";
import type { Session } from "../lib/session.js";

type Tx = Prisma.TransactionClient;

export const usersRepo = {
  byEmail: (email: string) => prisma.user.findUnique({ where: { email: email.toLowerCase() } }),
  byId: (id: string) => prisma.user.findUnique({ where: { id } }),

  /** Revokes every session of the user (all devices): tokens carry the old version and stop verifying. */
  revokeSessions: (id: string, db: Tx | typeof prisma = prisma) =>
    db.user.updateMany({ where: { id }, data: { sessionVersion: { increment: 1 } } }),

  /** Role change inside the caller's tenant; also revokes the user's sessions so the old role cannot be used. */
  changeRole: async (tx: Tx, id: string, tenantId: string, role: Session["role"]) => {
    const r = await tx.user.updateMany({ where: { id, tenantId }, data: { role, sessionVersion: { increment: 1 } } });
    return r.count === 1;
  },
};
