import { prisma, Prisma } from "@octavolab/db";
import type { OrderStatus } from "../lib/order-state.js";

type Tx = Prisma.TransactionClient;

export const ordersRepo = {
  /** Tenant-scoped read: an order from another tenant is indistinguishable from a missing one (no IDOR oracle). */
  byIdForTenant: (id: string, tenantId: string) =>
    prisma.order.findFirst({ where: { id, tenantId }, include: { items: true } }),

  /**
   * Customer-scoped read: tenant AND owner must match. Another customer's order (same tenant or not) is indistinguishable
   * from a missing one, so a customer cannot probe order ids (IDOR).
   */
  byIdForCustomer: (id: string, tenantId: string, customerUserId: string) =>
    prisma.order.findFirst({ where: { id, tenantId, customerUserId }, include: { items: true } }),

  /** The customer's own orders, newest first, keyset-paginated by id (cursor = last id of the previous page). */
  listForCustomer: (tenantId: string, customerUserId: string, opts: { limit: number; cursor?: string | undefined }) =>
    prisma.order.findMany({
      where: { tenantId, customerUserId },
      include: { items: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    }),

  /** Optimistic, race-safe transition: succeeds only if status is still one of `from` and the version matches. */
  transition: async (tx: Tx, id: string, from: OrderStatus[], to: OrderStatus, version: number, extra: { paymentIntentId?: string } = {}) => {
    const r = await tx.order.updateMany({ where: { id, version, status: { in: from } }, data: { ...extra, status: to, version: { increment: 1 } } });
    return r.count === 1;
  },
};
