import { prisma, Prisma } from "@octavolab/db";
import { AppError } from "../lib/errors.js";

type Tx = Prisma.TransactionClient;

export const idempotencyRepo = {
  /** Keys are scoped by tenant so one tenant can never replay (or read) another tenant's response. */
  scopedKey: (tenantId: string, clientKey: string) => `${tenantId}:${clientKey}`,

  /**
   * Returns the stored record when the key was already used for the same request, null when the key is new, and throws
   * 422 IDEMPOTENCY_MISMATCH when the key was used for a different operation or body.
   */
  find: async (key: string, hash: string) => {
    const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
    if (!existing) return null;
    if (existing.requestHash !== hash) throw new AppError("IDEMPOTENCY_MISMATCH", "Idempotency-Key was already used with a different request", 422);
    return existing;
  },

  save: (tx: Tx, key: string, hash: string, response: unknown) =>
    tx.idempotencyKey.create({ data: { key, requestHash: hash, response: JSON.stringify(response) } }),
};
