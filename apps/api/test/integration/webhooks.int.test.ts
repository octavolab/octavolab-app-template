/**
 * Payments webhook and checkout against a real PostgreSQL (CI service container, migrations applied).
 * What the unit tests can only simulate with the in-memory stand-in is checked here with real database semantics:
 * the unique WebhookEvent id raising P2002 for a duplicate delivery, and a failure inside the transaction rolling back
 * the event record, the state change, the audit entry and the outbox row together.
 * Runs with INTEGRATION=1 (fake payments adapter, NODE_ENV=test). Skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const run = process.env.INTEGRATION === "1";

describe.runIf(run)("payments webhook and checkout against PostgreSQL", () => {
  let prisma: any, app: any, cookie: string, orderId: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test", INTEGRATIONS_MODE: "fake", PAYMENTS_PROVIDER: "fake", RATE_LIMIT_MAX: "1000",
      SESSION_SECRET: process.env.SESSION_SECRET ?? "s".repeat(40), APP_URL: process.env.APP_URL ?? "http://localhost:5173", OPS_EMAIL: process.env.OPS_EMAIL ?? "ops@ci.invalid",
    });
    delete process.env.REDIS_URL;
    ({ prisma } = await import("@octavolab/db"));
    const argon2 = (await import("argon2")).default;
    await prisma.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Outbox","AuditLog","IdempotencyKey","WebhookEvent","User","Tenant" CASCADE');
    await prisma.tenant.create({ data: { id: "tW", name: "Webhook tenant" } });
    await prisma.user.create({ data: { id: "uW", email: "pay-admin@w.co", role: "admin", tenantId: "tW", passwordHash: await argon2.hash("correct-horse-w") } });
    const { createOrder } = await import("../../src/services/orders.service.js");
    orderId = (await createOrder({ customerEmail: "buyer@w.co", currency: "EUR", items: [{ sku: "W", qty: 2, unitAmount: 1050 }] }, "k-int-wh-order", { tenantId: "tW", actor: "test" })).id;
    const { buildApp } = await import("../../src/app.js");
    app = await buildApp();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "pay-admin@w.co", password: "correct-horse-w" } });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });

  afterAll(async () => {
    await prisma?.$executeRawUnsafe('DROP TRIGGER IF EXISTS "test_fail_order_paid" ON "Outbox"');
    await prisma?.$executeRawUnsafe("DROP FUNCTION IF EXISTS test_fail_order_paid()");
    await app?.close();
  });

  const event = (id: string, object: Record<string, unknown>) => ({ id, type: "payment_intent.succeeded", data: { object: { id: `fake_pi_${orderId}`, status: "succeeded", amount: 2100, amount_received: 2100, currency: "eur", metadata: { orderId }, ...object } } });
  const post = (body: object) => app.inject({ method: "POST", url: "/api/v1/webhooks/payments", headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });

  it("checkout moves the order to pending_payment and stores the provider intent id", async () => {
    const r = await app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/checkout`, headers: { cookie, "idempotency-key": "k-int-checkout-1" } });
    expect(r.statusCode).toBe(200);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect([o.status, o.paymentIntentId, o.totalAmount, o.currency]).toEqual(["pending_payment", `fake_pi_${orderId}`, 2100, "EUR"]);
    expect(await prisma.auditLog.count({ where: { entityId: orderId, action: "checkout_started" } })).toBe(1);
    const replay = await app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/checkout`, headers: { cookie, "idempotency-key": "k-int-checkout-1" } });
    expect(replay.json().paymentIntentId).toBe(`fake_pi_${orderId}`);
  });

  it("amount or currency mismatch: the event and the mismatch audit commit, the order is not paid", async () => {
    expect((await post(event("evt_int_amount", { amount: 1, amount_received: 1 }))).statusCode).toBe(200);
    expect((await post(event("evt_int_currency", { currency: "usd" }))).statusCode).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("pending_payment");
    expect(await prisma.auditLog.count({ where: { entityId: orderId, action: "payment_mismatch" } })).toBe(2);
    expect(await prisma.webhookEvent.count({ where: { id: { in: ["evt_int_amount", "evt_int_currency"] } } })).toBe(2);
    expect(await prisma.outbox.count({ where: { type: "order.paid" } })).toBe(0);
  });

  it("a failure inside the transaction rolls back event, state, audit and outbox; the provider retry then succeeds", async () => {
    // Make the outbox insert fail for order.paid only, inside the webhook transaction.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_order_paid() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'order.paid' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "test_fail_order_paid" BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION test_fail_order_paid()`);
    const failed = await post(event("evt_int_ok", {}));
    expect(failed.statusCode).toBe(500);
    expect(await prisma.webhookEvent.count({ where: { id: "evt_int_ok" } })).toBe(0);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(o.status).toBe("pending_payment");
    expect(await prisma.auditLog.count({ where: { entityId: orderId, action: "paid" } })).toBe(0);

    await prisma.$executeRawUnsafe('DROP TRIGGER "test_fail_order_paid" ON "Outbox"');
    const retry = await post(event("evt_int_ok", {}));
    expect(retry.statusCode).toBe(200);
    expect(retry.json().duplicate).toBeUndefined();
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(paid.status).toBe("paid");
    expect(paid.version).toBe(o.version + 1);
    expect(await prisma.outbox.count({ where: { type: "order.paid" } })).toBe(1);
  });

  it("a duplicate delivery hits the unique event id (P2002) and is acknowledged without effects", async () => {
    const dup = await post(event("evt_int_ok", {}));
    expect(dup.statusCode).toBe(200);
    expect(dup.json().duplicate).toBe(true);
    expect(await prisma.webhookEvent.count({ where: { id: "evt_int_ok" } })).toBe(1);
    expect(await prisma.outbox.count({ where: { type: "order.paid" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: orderId, action: "paid" } })).toBe(1);
  });
});
