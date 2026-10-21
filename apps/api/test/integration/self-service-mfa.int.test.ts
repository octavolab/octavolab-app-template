/**
 * Customer self-service and 2FA storage against a real PostgreSQL (CI service container, migrations applied).
 * Checks what the in-memory stand-in can only simulate: the (tenant, sku) unique index, the Order.customerUserId foreign key
 * (ON DELETE SET NULL), keyset pagination with a real cursor, and the atomic single-use updates behind TOTP steps and
 * recovery codes under concurrency.
 * Runs with INTEGRATION=1 (fake payments adapter, NODE_ENV=test). Skipped otherwise.
 */
import { describe, it, expect, beforeAll } from "vitest";

const run = process.env.INTEGRATION === "1";

describe.runIf(run)("customer self-service and 2FA storage against PostgreSQL", () => {
  let prisma: any, createCustomerOrder: any, startCheckout: any, ordersRepo: any, usersRepo: any, recoveryCodesRepo: any;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test", INTEGRATIONS_MODE: "fake", PAYMENTS_PROVIDER: "fake", RATE_LIMIT_MAX: "1000",
      SESSION_SECRET: process.env.SESSION_SECRET ?? "s".repeat(40), APP_URL: process.env.APP_URL ?? "http://localhost:5173", OPS_EMAIL: process.env.OPS_EMAIL ?? "ops@ci.invalid",
      TOTP_ENC_KEY: Buffer.alloc(32, 5).toString("base64"),
    });
    ({ prisma } = await import("@octavolab/db"));
    ({ createCustomerOrder } = await import("../../src/services/orders.service.js"));
    ({ startCheckout } = await import("../../src/services/checkout.service.js"));
    ({ ordersRepo } = await import("../../src/repositories/orders.repository.js"));
    ({ usersRepo, recoveryCodesRepo } = await import("../../src/repositories/users.repository.js"));
    await prisma.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Outbox","AuditLog","IdempotencyKey","WebhookEvent","MfaRecoveryCode","Product","User","Tenant" CASCADE');
    await prisma.tenant.createMany({ data: [{ id: "tS", name: "Shop" }, { id: "tO", name: "Other" }] });
    await prisma.user.createMany({ data: [
      { id: "cS1", email: "c1@s.co", role: "customer", tenantId: "tS", passwordHash: "x" },
      { id: "cS2", email: "c2@s.co", role: "customer", tenantId: "tS", passwordHash: "x" },
      { id: "aS1", email: "a1@s.co", role: "admin", tenantId: "tS", passwordHash: "x" },
    ] });
    await prisma.product.createMany({ data: [
      { tenantId: "tS", sku: "BOX", name: "Box", unitAmount: 1500, currency: "GBP" },
      { tenantId: "tO", sku: "BOX", name: "Other box", unitAmount: 1, currency: "GBP" },
    ] });
  });

  it("enforces one product per (tenant, sku)", async () => {
    await expect(prisma.product.create({ data: { tenantId: "tS", sku: "BOX", name: "dup", unitAmount: 1, currency: "GBP" } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("creates customer orders priced from the tenant's catalog and scopes reads and pagination to the owner", async () => {
    const ctx = (id: string, email: string) => ({ tenantId: "tS", actor: `user:${id}`, userId: id, email });
    const a = await createCustomerOrder({ items: [{ sku: "BOX", qty: 2 }] }, "k-int-me-1", ctx("cS1", "c1@s.co"));
    const b = await createCustomerOrder({ items: [{ sku: "BOX", qty: 1 }] }, "k-int-me-2", ctx("cS1", "c1@s.co"));
    const same = await createCustomerOrder({ items: [{ sku: "BOX", qty: 2 }] }, "k-int-me-1", ctx("cS2", "c2@s.co")); // same key, other customer
    expect([a.totalAmount, a.customerUserId, a.customerEmail]).toEqual([3000, "cS1", "c1@s.co"]);
    expect(same.id).not.toBe(a.id);
    expect(await ordersRepo.byIdForCustomer(a.id, "tS", "cS2")).toBeNull();
    expect(await ordersRepo.byIdForCustomer(a.id, "tO", "cS1")).toBeNull();
    expect((await ordersRepo.byIdForCustomer(a.id, "tS", "cS1")).items.length).toBe(1);
    const page1 = await ordersRepo.listForCustomer("tS", "cS1", { limit: 1 });
    expect(page1.length).toBe(2); // limit + 1 tells the route there is a next page
    const page2 = await ordersRepo.listForCustomer("tS", "cS1", { limit: 1, cursor: page1[0].id });
    expect(page2.map((o: { id: string }) => o.id)).toEqual([[a.id, b.id].find((id) => id !== page1[0].id)]);

    await expect(startCheckout(a.id, "k-int-me-pay-x", { tenantId: "tS", actor: "user:cS2", customerUserId: "cS2" })).rejects.toMatchObject({ status: 404 });
    const paid = await startCheckout(a.id, "k-int-me-pay-1", { tenantId: "tS", actor: "user:cS1", customerUserId: "cS1" });
    expect(paid.status).toBe("pending_payment");
    expect((await prisma.order.findUnique({ where: { id: a.id } })).status).toBe("pending_payment");
  });

  it("keeps the order when its customer account is deleted (customerUserId set to NULL)", async () => {
    const u = await prisma.user.create({ data: { email: "gone@s.co", role: "customer", tenantId: "tS", passwordHash: "x" } });
    const o = await createCustomerOrder({ items: [{ sku: "BOX", qty: 1 }] }, "k-int-me-gone", { tenantId: "tS", actor: "t", userId: u.id, email: u.email });
    await prisma.user.delete({ where: { id: u.id } });
    expect((await prisma.order.findUnique({ where: { id: o.id } })).customerUserId).toBeNull();
  });

  it("accepts each TOTP step once, even for concurrent requests", async () => {
    await prisma.user.update({ where: { id: "aS1" }, data: { totpSecret: "v1.x.y.z", totpEnabledAt: new Date(), totpLastStep: 100 } });
    const results = await Promise.all([usersRepo.consumeTotpStep("aS1", 101), usersRepo.consumeTotpStep("aS1", 101), usersRepo.consumeTotpStep("aS1", 101)]);
    expect(results.filter(Boolean).length).toBe(1);
    expect(await usersRepo.consumeTotpStep("aS1", 100)).toBe(false);
    expect(await usersRepo.consumeTotpStep("aS1", 102)).toBe(true);
  });

  it("uses a recovery code once under concurrency, and deleting the user deletes its codes", async () => {
    await prisma.$transaction((tx: any) => recoveryCodesRepo.replace(tx, "aS1", ["h1", "h2"]));
    const now = new Date();
    const results = await Promise.all([recoveryCodesRepo.use("aS1", "h1", now), recoveryCodesRepo.use("aS1", "h1", now)]);
    expect(results.filter(Boolean).length).toBe(1);
    expect(await recoveryCodesRepo.remaining("aS1")).toBe(1);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = 'aS1'`);
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: "aS1" } })).toBe(0);
  });
});
