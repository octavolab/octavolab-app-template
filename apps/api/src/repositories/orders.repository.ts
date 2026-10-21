import { prisma, Prisma } from "@octavolab/db";
import type { OrderStatus } from "../lib/order-state.js";

type Tx = Prisma.TransactionClient;

export const ordersRepo = {
  /** Tenant-scoped read: an order from another tenant is indistinguishable from a missing one (no IDOR oracle). */
  byIdForTenant: (id: string, tenantId: string) =>
    prisma.order.findFirst({ where: { id, tenantId }, include: { items: true } }),

  /** Optimistic, race-safe transition: succeeds only if status is still one of `from` and the version matches. */
  transition: async (tx: Tx, id: string, from: OrderStatus[], to: OrderStatus, version: number, extra: { paymentIntentId?: string } = {}) => {
    const r = await tx.order.updateMany({ where: { id, version, status: { in: from } }, data: { ...extra, status: to, version: { increment: 1 } } });
    return r.count === 1;
  },
};
