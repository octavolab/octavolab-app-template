/**
 * Integration tests against a real PostgreSQL (CI service container, migrations applied with `prisma migrate deploy`).
 * Run with: INTEGRATION=1 pnpm --filter api test:int. Skipped otherwise.
 */
import { describe, it, expect, beforeAll } from "vitest";

const run = process.env.INTEGRATION === "1";

describe.runIf(run)("orders against PostgreSQL", () => {
  let prisma: any, createOrder: any, ordersRepo: any;
  beforeAll(async () => {
    ({ prisma } = await import("@octavolab/db"));
    ({ createOrder } = await import("../../src/services/orders.service.js"));
    ({ ordersRepo } = await import("../../src/repositories/orders.repository.js"));
    await prisma.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Outbox","AuditLog","IdempotencyKey","WebhookEvent","User","Tenant" CASCADE');
    await prisma.tenant.create({ data: { id: "tA", name: "Tenant A" } });
  });

  it("is idempotent per tenant and writes order, items, audit and outbox in one transaction", async () => {
    const input = { customerEmail: "x@y.co", currency: "USD", items: [{ sku: "A", qty: 2, unitAmount: 1250 }] };
    const a = await createOrder(input, "k-int-1", { tenantId: "tA", actor: "test" });
    const b = await createOrder(input, "k-int-1", { tenantId: "tA", actor: "test" });
    expect(b.id).toBe(a.id);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.orderItem.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(1);
    expect(await prisma.outbox.count()).toBe(1);
  });

  it("binds the key to the body (422) and the database refuses an order without tenant", async () => {
    const other = { customerEmail: "x@y.co", currency: "USD", items: [{ sku: "A", qty: 3, unitAmount: 1250 }] };
    await expect(createOrder(other, "k-int-1", { tenantId: "tA", actor: "test" })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH", status: 422 });
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "Order"(id,"customerEmail",currency,"totalAmount","updatedAt") VALUES ('o-null','a@b.co','USD',1,now())`)).rejects.toThrow();
    const key = await prisma.idempotencyKey.findFirstOrThrow();
    expect(key.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("optimistic transition succeeds once and rejects a stale version", async () => {
    const o = await prisma.order.findFirstOrThrow();
    const first = await prisma.$transaction((tx: any) => ordersRepo.transition(tx, o.id, ["draft"], "confirmed", o.version));
    const stale = await prisma.$transaction((tx: any) => ordersRepo.transition(tx, o.id, ["draft"], "confirmed", o.version));
    expect(first).toBe(true);
    expect(stale).toBe(false);
  });

  it("outbox rows are claimed by exactly one worker", async () => {
    const claim = () => prisma.$queryRaw`UPDATE "Outbox" SET "lockedUntil" = now() + interval '60 seconds' WHERE id IN (SELECT id FROM "Outbox" WHERE "deliveredAt" IS NULL AND attempts < 8 AND ("lockedUntil" IS NULL OR "lockedUntil" < now()) ORDER BY "createdAt" LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING id`;
    const [r1, r2] = await Promise.all([claim(), claim()]);
    expect((r1 as unknown[]).length + (r2 as unknown[]).length).toBe(1);
  });
});
