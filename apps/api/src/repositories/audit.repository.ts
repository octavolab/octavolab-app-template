import { prisma, Prisma } from "@octavolab/db";

type Tx = Prisma.TransactionClient;
export type AuditEntry = { entity: string; entityId: string; action: string; actor: string; before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue };

export const auditRepo = {
  /** Append-only audit trail (ASVS 7.2). Pass `tx` to commit the entry with the business write it describes. */
  record: (entry: AuditEntry, db: Tx | typeof prisma = prisma) => db.auditLog.create({ data: entry }),
};
