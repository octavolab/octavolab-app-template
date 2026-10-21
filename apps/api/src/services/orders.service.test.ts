import { describe, it, expect, vi } from "vitest";
// Unit test with a mocked prisma. DB integration tests against the CI Postgres service live in test/integration (INTEGRATION=1 pnpm --filter api test:int).
vi.mock("@octavolab/db", () => {
  const store: Record<string, { response: string; requestHash: string }> = {};
  let n = 0;
  const tx = {
    order: { create: vi.fn(async ({ data }: { data: { totalAmount: number } }) => ({ id: `o${++n}`, ...data, items: [] })) },
    auditLog: { create: vi.fn(async () => ({})) },
    outbox: { create: vi.fn(async () => ({})) },
    idempotencyKey: { create: vi.fn(async ({ data }: { data: { key: string; response: string; requestHash: string } }) => { store[data.key] = data; return data; }) },
  };
  return { Prisma: { PrismaClientKnownRequestError: class extends Error { code = "" } },
    prisma: { idempotencyKey: { findUnique: vi.fn(async ({ where }: { where: { key: string } }) => store[where.key] ?? null) }, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } };
});
import { createOrder } from "./orders.service.js";

const ctx = { tenantId: "tA", actor: "test" };
const input = { customerEmail: "a@b.co", currency: "USD", items: [{ sku: "A", qty: 2, unitAmount: 1250 }] };

describe("createOrder", () => {
  it("computes total in minor units and is idempotent for the same body (key order does not matter)", async () => {
    const first = await createOrder(input, "key-12345678", ctx);
    expect(first.totalAmount).toBe(2500);
    const reordered = { items: [{ unitAmount: 1250, qty: 2, sku: "A" }], currency: "USD", customerEmail: "a@b.co" };
    const second = await createOrder(reordered, "key-12345678", ctx);
    expect(second.id).toBe(first.id);
  });

  it("rejects the same key with a different body (422 IDEMPOTENCY_MISMATCH)", async () => {
    await createOrder(input, "key-mismatch-1", ctx);
    const other = { ...input, items: [{ sku: "A", qty: 3, unitAmount: 1250 }] };
    await expect(createOrder(other, "key-mismatch-1", ctx)).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH", status: 422 });
  });

  it("scopes keys by tenant and never accepts a missing tenant", async () => {
    const a = await createOrder(input, "key-shared-1", ctx);
    const b = await createOrder(input, "key-shared-1", { tenantId: "tB", actor: "test" });
    expect(b.id).not.toBe(a.id);
    await expect(createOrder(input, "key-x-12345", { tenantId: "", actor: "test" })).rejects.toMatchObject({ status: 403 });
  });

  it("refuses totals beyond the 32-bit minor-unit column", async () => {
    await expect(createOrder({ ...input, items: [{ sku: "A", qty: 10_000, unitAmount: 300_000 }] }, "key-big-1234", ctx)).rejects.toMatchObject({ code: "AMOUNT_RANGE" });
  });
});
