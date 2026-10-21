import { describe, it, expect, vi } from "vitest";
// Unit test with a mocked prisma. There is no DB integration test yet: add one against the CI Postgres service once packages/db/prisma/migrations exists.
vi.mock("@octavolab/db", () => {
  const store: Record<string, unknown> = {};
  const tx = {
    order: { create: vi.fn(async ({ data }: { data: { totalAmount: number } }) => ({ id: "o1", ...data, items: [] })) },
    auditLog: { create: vi.fn(async () => ({})) },
    outbox: { create: vi.fn(async () => ({})) },
    idempotencyKey: { create: vi.fn(async ({ data }: { data: { key: string; response: string } }) => { store[data.key] = data.response; return data; }) },
  };
  return { Prisma: { PrismaClientKnownRequestError: class extends Error { code = "" } },
    prisma: { idempotencyKey: { findUnique: vi.fn(async ({ where }: { where: { key: string } }) => store[where.key] ? { response: store[where.key] } : null) }, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } };
});
import { createOrder } from "./orders.service.js";

describe("createOrder", () => {
  it("computes total in minor units and is idempotent", async () => {
    const input = { customerEmail: "a@b.co", currency: "USD", items: [{ sku: "A", qty: 2, unitAmount: 1250 }] };
    const first = await createOrder(input, "key-12345678");
    expect(first.totalAmount).toBe(2500);
    const second = await createOrder(input, "key-12345678");
    expect(second.id).toBe(first.id);
  });
});
