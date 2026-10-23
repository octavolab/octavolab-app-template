import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import argon2 from "argon2";
import { db } from "../test-support/prisma-stand-in.js";

// Environment must be set before the app (and its env schema) is imported.
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "http://localhost:5173", OPS_EMAIL: "ops@test.invalid", RATE_LIMIT_MAX: "1000",
  INTEGRATIONS_MODE: "test", PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test",
  MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_test_x", MESSAGING_FROM: "noreply@test.invalid", // test mode requires both real adapters (env.ts)
  TOTP_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
});
delete process.env.REDIS_URL;

vi.mock("@octavolab/db", async () => (await import("../test-support/prisma-stand-in.js")).dbModule);

// Stripe API stand-in: honours Idempotency-Key like Stripe does.
const stripe = vi.hoisted(() => ({ calls: [] as { method: string; url: string; key: string | undefined }[], byKey: new Map<string, string>() }));
vi.stubGlobal("fetch", async (url: string, init: { method: string; headers: Record<string, string> }) => {
  const key = init.headers["Idempotency-Key"];
  stripe.calls.push({ method: init.method, url, key });
  let id = url.split("/").pop()!;
  if (init.method === "POST") { id = (key && stripe.byKey.get(key)) ?? `pi_me_${stripe.byKey.size + 1}`; if (key) stripe.byKey.set(key, id); }
  return new Response(JSON.stringify({ id, client_secret: `${id}_secret_me`, status: "requires_payment_method" }), { status: 200 });
});

let app: Awaited<ReturnType<typeof import("../app.js")["buildApp"]>>;
const cookieOf = (res: { headers: Record<string, unknown> }): string => String(res.headers["set-cookie"]).split(";")[0] ?? "";
let ipSeq = 0;
const login = async (email: string, password: string) => cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": `10.7.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` }, payload: { email, password } }));
const post = (url: string, cookie: string, payload?: object, key?: string) =>
  app.inject({ method: "POST", url, headers: { cookie, ...(key ? { "idempotency-key": key } : {}) }, ...(payload ? { payload } : {}) });
const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });

let c1: string, c2: string, c3: string, admin: string, ops: string;

beforeAll(async () => {
  const pw = await argon2.hash("customer-pass-1");
  db.users.push(
    { id: "cust-1", email: "ana@a.co", role: "customer", tenantId: "tA", sessionVersion: 0, passwordHash: pw },
    { id: "cust-2", email: "bob@a.co", role: "customer", tenantId: "tA", sessionVersion: 0, passwordHash: pw },
    { id: "cust-3", email: "cy@b.co", role: "customer", tenantId: "tB", sessionVersion: 0, passwordHash: pw },
    { id: "cust-x", email: "nobody@x.co", role: "customer", tenantId: null, sessionVersion: 0, passwordHash: pw },
    { id: "adm-1", email: "adm@a.co", role: "admin", tenantId: "tA", sessionVersion: 0, passwordHash: pw },
    { id: "ops-1", email: "ops@a.co", role: "operations", tenantId: "tA", sessionVersion: 0, passwordHash: pw },
  );
  db.products.push(
    { id: "p-a1", tenantId: "tA", sku: "TEE", name: "T-shirt", unitAmount: 1500, currency: "GBP", active: true },
    { id: "p-a2", tenantId: "tA", sku: "MUG", name: "Mug", unitAmount: 250, currency: "GBP", active: true },
    { id: "p-a3", tenantId: "tA", sku: "HAT-US", name: "Hat", unitAmount: 900, currency: "USD", active: true },
    { id: "p-a4", tenantId: "tA", sku: "OLD", name: "Retired", unitAmount: 100, currency: "GBP", active: false },
    { id: "p-b1", tenantId: "tB", sku: "TEE", name: "Other tenant tee", unitAmount: 1, currency: "GBP", active: true },
  );
  app = await (await import("../app.js")).buildApp();
  [c1, c2, c3, admin, ops] = (await Promise.all(["ana@a.co", "bob@a.co", "cy@b.co", "adm@a.co", "ops@a.co"].map((e) => login(e, "customer-pass-1")))) as [string, string, string, string, string];
});

describe("product catalog", () => {
  it("owner and admin upsert products by SKU (audited); operations and customers cannot", async () => {
    const r = await app.inject({ method: "PUT", url: "/api/v1/products/SCARF", headers: { cookie: admin }, payload: { name: "Scarf", unitAmount: 1200, currency: "GBP" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ tenantId: "tA", sku: "SCARF", unitAmount: 1200, active: true });
    const again = await app.inject({ method: "PUT", url: "/api/v1/products/SCARF", headers: { cookie: admin }, payload: { name: "Scarf", unitAmount: 1300, currency: "GBP" } });
    expect(again.json().id).toBe(r.json().id); // natural key: one row per (tenant, sku)
    expect(db.audit.filter((a) => a.entity === "Product" && a.entityId === r.json().id).map((a) => a.action)).toEqual(["create", "update"]);
    for (const cookie of [ops, c1]) {
      expect((await app.inject({ method: "PUT", url: "/api/v1/products/SCARF", headers: { cookie }, payload: { name: "x", unitAmount: 1, currency: "GBP" } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "PUT", url: "/api/v1/products/SCARF", headers: { cookie: admin }, payload: { name: "x", unitAmount: 0, currency: "GBP" } })).statusCode).toBe(400);
  });

  it("customers see only their tenant's active products; staff also see inactive ones", async () => {
    const mine = (await get("/api/v1/products", c1)).json().items.map((p: { sku: string }) => p.sku);
    expect(mine).toEqual(["HAT-US", "MUG", "SCARF", "TEE"]);
    expect((await get("/api/v1/products", admin)).json().items.map((p: { sku: string }) => p.sku)).toContain("OLD");
    expect((await get("/api/v1/products", c3)).json().items.map((p: { name: string }) => p.name)).toEqual(["Other tenant tee"]);
  });
});

describe("customer self-service orders and checkout", () => {
  let orderId: string;

  it("creates a draft order for the caller, priced from the catalog, never from the body", async () => {
    const r = await post("/api/v1/me/orders", c1, { items: [{ sku: "TEE", qty: 2 }, { sku: "MUG", qty: 1 }] }, "me-key-0001");
    expect(r.statusCode).toBe(201);
    const o = r.json();
    expect(o).toMatchObject({ tenantId: "tA", customerUserId: "cust-1", customerEmail: "ana@a.co", currency: "GBP", totalAmount: 3250, status: "draft" });
    expect(o.items.map((i: { sku: string; unitAmount: number }) => [i.sku, i.unitAmount])).toEqual([["TEE", 1500], ["MUG", 250]]);
    expect(db.outbox.some((e) => e.type === "order.created" && e.payload.orderId === o.id)).toBe(true);
    expect(db.audit.some((a) => a.entity === "Order" && a.entityId === o.id && a.actor === "user:cust-1")).toBe(true);
    orderId = o.id;
  });

  it("rejects client-supplied prices, tenant or owner fields (400) and bad catalog input (422)", async () => {
    const bad = [
      { items: [{ sku: "TEE", qty: 1, unitAmount: 1 }] },
      { items: [{ sku: "TEE", qty: 1 }], currency: "USD" },
      { items: [{ sku: "TEE", qty: 1 }], customerUserId: "cust-2" },
      { items: [{ sku: "TEE", qty: 1 }], tenantId: "tB" },
      { items: [] },
      { items: [{ sku: "TEE", qty: 0 }] },
    ];
    for (const [i, body] of bad.entries()) expect((await post("/api/v1/me/orders", c1, body, `me-bad-000${i}`)).statusCode).toBe(400);
    const codes = async (body: object, key: string) => { const r = await post("/api/v1/me/orders", c1, body, key); return [r.statusCode, r.json().code]; };
    expect(await codes({ items: [{ sku: "NOPE", qty: 1 }] }, "me-422-0001")).toEqual([422, "UNKNOWN_SKU"]);
    expect(await codes({ items: [{ sku: "OLD", qty: 1 }] }, "me-422-0002")).toEqual([422, "UNKNOWN_SKU"]); // inactive
    expect(await codes({ items: [{ sku: "TEE", qty: 1 }, { sku: "HAT-US", qty: 1 }] }, "me-422-0003")).toEqual([422, "MIXED_CURRENCY"]);
    expect(await codes({ items: [{ sku: "TEE", qty: 1 }, { sku: "TEE", qty: 2 }] }, "me-422-0004")).toEqual([422, "DUPLICATE_SKU"]);
    expect((await post("/api/v1/me/orders", c1, { items: [{ sku: "TEE", qty: 1 }] })).statusCode).toBe(400); // Idempotency-Key required
  });

  it("is idempotent per customer: same key replays even after a price change; another body is 422", async () => {
    const tee = db.products.find((p) => p.id === "p-a1")!;
    tee.unitAmount = 9999;
    const replay = await post("/api/v1/me/orders", c1, { items: [{ sku: "TEE", qty: 2 }, { sku: "MUG", qty: 1 }] }, "me-key-0001");
    tee.unitAmount = 1500;
    expect(replay.statusCode).toBe(201);
    expect([replay.json().id, replay.json().totalAmount]).toEqual([orderId, 3250]);
    const mismatch = await post("/api/v1/me/orders", c1, { items: [{ sku: "TEE", qty: 3 }] }, "me-key-0001");
    expect([mismatch.statusCode, mismatch.json().code]).toEqual([422, "IDEMPOTENCY_MISMATCH"]);
  });

  it("two customers using the same Idempotency-Key get independent orders (keys scoped to the customer)", async () => {
    const r = await post("/api/v1/me/orders", c2, { items: [{ sku: "TEE", qty: 2 }, { sku: "MUG", qty: 1 }] }, "me-key-0001");
    expect(r.statusCode).toBe(201);
    expect(r.json().id).not.toBe(orderId);
    expect(r.json().customerUserId).toBe("cust-2");
  });

  it("is customer-only: staff use /orders, anonymous gets 401, a customer without tenant gets 403", async () => {
    expect((await post("/api/v1/me/orders", admin, { items: [{ sku: "TEE", qty: 1 }] }, "me-staff-001")).statusCode).toBe(403);
    expect((await get("/api/v1/me/orders", ops)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/me/orders" })).statusCode).toBe(401);
    const none = await login("nobody@x.co", "customer-pass-1");
    const r = await post("/api/v1/me/orders", none, { items: [{ sku: "TEE", qty: 1 }] }, "me-none-0001");
    expect([r.statusCode, r.json().code]).toEqual([403, "TENANT_REQUIRED"]);
  });

  it("starts checkout for the caller's own order through the shared checkout path", async () => {
    stripe.calls.length = 0;
    const r = await post(`/api/v1/me/orders/${orderId}/checkout`, c1, undefined, "me-pay-0001");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ orderId, status: "pending_payment", amount: 3250, currency: "GBP" });
    expect(r.json().clientSecret).toMatch(/_secret_me$/);
    const creates = stripe.calls.filter((c) => c.method === "POST");
    expect(creates.map((c) => c.key)).toEqual([`checkout:${orderId}`]);
    expect(db.orders.find((o) => o.id === orderId)!.status).toBe("pending_payment");
    expect(db.audit.some((a) => a.action === "checkout_started" && a.entityId === orderId && a.actor === "user:cust-1")).toBe(true);

    const replay = await post(`/api/v1/me/orders/${orderId}/checkout`, c1, undefined, "me-pay-0001");
    const resumed = await post(`/api/v1/me/orders/${orderId}/checkout`, c1, undefined, "me-pay-0002");
    expect([replay.json().paymentIntentId, resumed.json().paymentIntentId]).toEqual([r.json().paymentIntentId, r.json().paymentIntentId]);
    expect(stripe.calls.filter((c) => c.method === "POST").length).toBe(1); // no second intent
  });

  it("IDOR: another customer (same or other tenant) cannot read, list or check out the order; 404 like a missing id", async () => {
    const order = db.orders.find((o) => o.id === orderId)!;
    const before = { status: order.status, version: order.version };
    stripe.calls.length = 0;
    for (const cookie of [c2, c3]) {
      expect((await get(`/api/v1/me/orders/${orderId}`, cookie)).statusCode).toBe(404);
      const r = await post(`/api/v1/me/orders/${orderId}/checkout`, cookie, undefined, "me-pay-0001"); // even with the owner's key
      expect([r.statusCode, r.json().code]).toEqual([404, "NOT_FOUND"]);
      expect((await get("/api/v1/me/orders", cookie)).json().items.some((o: { id: string }) => o.id === orderId)).toBe(false);
    }
    expect((await get("/api/v1/me/orders/does-not-exist", c2)).json().code).toBe("NOT_FOUND"); // same answer as a foreign id
    expect({ status: order.status, version: order.version }).toEqual(before);
    expect(stripe.calls.length).toBe(0);
    // The staff routes stay closed to customers.
    expect((await get(`/api/v1/orders/${orderId}`, c1)).statusCode).toBe(403);
    expect((await post(`/api/v1/orders/${orderId}/checkout`, c2, undefined, "me-staff-pay1")).statusCode).toBe(403);
  });

  it("does not expose staff-created orders to a customer even when the customer email matches", async () => {
    const staff = await post("/api/v1/orders", admin, { customerEmail: "ana@a.co", currency: "GBP", items: [{ sku: "TEE", qty: 1, unitAmount: 1500 }] }, "me-staff-ord1");
    expect(staff.statusCode).toBe(201);
    expect((await get(`/api/v1/me/orders/${staff.json().id}`, c1)).statusCode).toBe(404);
    expect((await post(`/api/v1/me/orders/${staff.json().id}/checkout`, c1, undefined, "me-pay-staff1")).statusCode).toBe(404);
  });

  it("lists only the caller's orders, newest first, with a cursor", async () => {
    await post("/api/v1/me/orders", c1, { items: [{ sku: "MUG", qty: 4 }] }, "me-key-0002");
    const page1 = (await get("/api/v1/me/orders?limit=1", c1)).json();
    expect(page1.items.length).toBe(1);
    expect(page1.items[0].totalAmount).toBe(1000);
    expect(page1.nextCursor).toBe(page1.items[0].id);
    const page2 = (await get(`/api/v1/me/orders?limit=1&cursor=${page1.nextCursor}`, c1)).json();
    expect(page2.items.map((o: { id: string }) => o.id)).toEqual([orderId]);
    expect(page2.nextCursor).toBeNull();
    const all = (await get("/api/v1/me/orders", c1)).json().items;
    expect(all.every((o: { customerUserId: string; tenantId: string }) => o.customerUserId === "cust-1" && o.tenantId === "tA")).toBe(true);
    expect((await get("/api/v1/me/orders?limit=0", c1)).statusCode).toBe(400);
    // Another customer's order id is not a valid cursor (no ordering oracle).
    const bad = await get(`/api/v1/me/orders?limit=1&cursor=${page1.nextCursor}`, c2);
    expect([bad.statusCode, bad.json().code]).toEqual([400, "BAD_CURSOR"]);
  });

  it("the signed webhook moves the customer's order to paid, visible on GET /me/orders/:id", async () => {
    const pi = db.orders.find((o) => o.id === orderId)!.paymentIntentId;
    const body = JSON.stringify({ id: "evt_me_paid", type: "payment_intent.succeeded", data: { object: { id: pi, status: "succeeded", amount: 3250, amount_received: 3250, currency: "gbp", metadata: { orderId } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`;
    expect((await app.inject({ method: "POST", url: "/api/v1/webhooks/payments", headers: { "content-type": "application/json", "stripe-signature": sig }, payload: body })).statusCode).toBe(200);
    expect((await get(`/api/v1/me/orders/${orderId}`, c1)).json().status).toBe("paid");
    const again = await post(`/api/v1/me/orders/${orderId}/checkout`, c1, undefined, "me-pay-0003");
    expect([again.statusCode, again.json().code]).toEqual([409, "INVALID_STATE"]);
  });
});
