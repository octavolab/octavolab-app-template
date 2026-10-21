import { prisma, Prisma } from "@octavolab/db";
import type { Session } from "../lib/session.js";

type Tx = Prisma.TransactionClient;

export const usersRepo = {
  byEmail: (email: string) => prisma.user.findUnique({ where: { email: email.toLowerCase() } }),
  byId: (id: string) => prisma.user.findUnique({ where: { id } }),

  /** Revokes every session of the user (all devices): tokens carry the old version and stop verifying. */
  revokeSessions: (id: string, db: Tx | typeof prisma = prisma) =>
    db.user.updateMany({ where: { id }, data: { sessionVersion: { increment: 1 } } }),

  /** Stores a new pending TOTP secret (ciphertext). Refused (count 0) once 2FA is enabled: disable first. */
  setPendingTotp: async (id: string, ciphertext: string) => {
    const r = await prisma.user.updateMany({ where: { id, totpEnabledAt: null }, data: { totpSecret: ciphertext, totpLastStep: null } });
    return r.count === 1;
  },

  /** Pending -> enabled, remembering the step used to activate and revoking every existing session of the user. */
  activateTotp: async (tx: Tx, id: string, step: number, now: Date) => {
    const r = await tx.user.updateMany({ where: { id, totpEnabledAt: null, totpSecret: { not: null } }, data: { totpEnabledAt: now, totpLastStep: step, sessionVersion: { increment: 1 } } });
    return r.count === 1;
  },

  /** Atomically accepts a TOTP step only if it is newer than the last one used: each code works once (replay-safe). */
  consumeTotpStep: async (id: string, step: number) => {
    const r = await prisma.user.updateMany({ where: { id, totpEnabledAt: { not: null }, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } });
    return r.count === 1;
  },

  /** Removes 2FA (secret, state and recovery codes are cleared by the caller in the same transaction) and revokes sessions. */
  clearTotp: (tx: Tx, id: string) =>
    tx.user.updateMany({ where: { id }, data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null, sessionVersion: { increment: 1 } } }),

  /** Role change inside the caller's tenant; also revokes the user's sessions so the old role cannot be used. */
  changeRole: async (tx: Tx, id: string, tenantId: string, role: Session["role"]) => {
    const r = await tx.user.updateMany({ where: { id, tenantId }, data: { role, sessionVersion: { increment: 1 } } });
    return r.count === 1;
  },
};

export const recoveryCodesRepo = {
  /** Replaces every recovery code of the user (old ones stop working) with the given keyed hashes. */
  replace: async (tx: Tx, userId: string, hashes: string[]) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId, codeHash })) });
  },
  deleteAll: (tx: Tx, userId: string) => tx.mfaRecoveryCode.deleteMany({ where: { userId } }),

  /** Single use, race-safe: only the request that flips usedAt from null wins. */
  use: async (userId: string, codeHash: string, now: Date) => {
    const r = await prisma.mfaRecoveryCode.updateMany({ where: { userId, codeHash, usedAt: null }, data: { usedAt: now } });
    return r.count >= 1;
  },
  remaining: (userId: string) => prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
};
