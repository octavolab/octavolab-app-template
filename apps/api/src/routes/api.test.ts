import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import argon2 from "argon2";

// Environment must be set before the app (and its env schema) is imported.
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "http://localhost:5173",
  INTEGRATIONS_MODE: "sandbox", PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test",
});

// In-memory stand-in for Prisma: enough behaviour to exercise auth, tenancy, idempotency and webhook dedupe end to end.
const db = vi.hoisted(() => ({ users: [] as any[], orders: [] as any[], keys: new Map<string, string>(), events: new Set<string>(), audit: [] as any[], outbox: [] as any[] }));
vi.mock("@octavolab/db", () => {
  class PrismaClientKnownRequestError extends Error { constructor(public code: string) { super(code); } }
  const prisma: any = {
    user: { findUnique: async ({ where }: any) => db.users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) ?? null },
    order: {
      create: async ({ data }: any) => { const o = { id: `o${db.orders.length + 1}`, version: 0, ...data, items: data.items.create }; db.orders.push(o); return o; },
      findFirst: async ({ where }: any) => db.orders.find((o) => o.id === where.id && o.tenantId === where.tenantId) ?? null,
      findUnique: async ({ where }: any) => db.orders.find((o) => o.id === where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        const o = db.orders.find((x) => x.id === where.id && x.version === where.version && where.status.in.includes(x.status));
        if (!o) return { count: 0 };
        o.status = data.status; o.version += 1; return { count: 1 };
      },
    },
    idempotencyKey: {
      findUnique: async ({ where }: any) => (db.keys.has(where.key) ? { response: db.keys.get(where.key) } : null),
      create: async ({ data }: any) => { db.keys.set(data.key, data.response); return data; },
    },
    auditLog: { create: async ({ data }: any) => { db.audit.push(data); return data; } },
    outbox: { create: async ({ data }: any) => { db.outbox.push(data); return data; } },
    webhookEvent: { create: async ({ data }: any) => { if (db.events.has(data.id)) throw new PrismaClientKnownRequestError("P2002"); db.events.add(data.id); return data; } },
    $transaction: async (fn: any) => fn(prisma),
    $queryRaw: async () => [{ 1: 1 }],
  };
  return { prisma, Prisma: { PrismaClientKnownRequestError } };
});

let app: any;
const cookieOf = (res: any) => String(res.headers["set-cookie"]).split(";")[0];

beforeAll(async () => {
  db.users.push(
    { id: "u-admin", email: "admin@a.co", role: "admin", tenantId: "tA", passwordHash: await argon2.hash("correct-horse-1") },
    { id: "u-cust", email: "c@a.co", role: "customer", tenantId: "tA", passwordHash: await argon2.hash("correct-horse-2") },
    { id: "u-b", email: "b@b.co", role: "admin", tenantId: "tB", passwordHash: await argon2.hash("correct-horse-3") },
  );
  const { buildApp } = await import("../app.js");
  app = await buildApp();
});

const login = async (email: string, password: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
const order = { customerEmail: "x@y.co", currency: "USD", items: [{ sku: "A", qty: 2, unitAmount: 1250 }] };

describe("API: auth, tenancy, idempotency, webhooks", () => {
  it("rejects writes without a session (401) and bad payloads with 400, not 500", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/orders", headers: { "idempotency-key": "k-00000001" }, payload: order })).statusCode).toBe(401);
    expect((await login("admin@a.co", "short")).statusCode).toBe(400);
  });

  it("does not reveal whether an email exists", async () => {
    const a = await login("nobody@a.co", "whatever-123");
    const b = await login("admin@a.co", "wrong-password-1");
    expect(a.statusCode).toBe(401); expect(b.statusCode).toBe(401);
    expect(a.json().code).toBe(b.json().code);
  });

  it("enforces roles (customer cannot create orders: 403)", async () => {
    const c = cookieOf(await login("c@a.co", "correct-horse-2"));
    const r = await app.inject({ method: "POST", url: "/api/v1/orders", headers: { cookie: c, "idempotency-key": "k-00000002" }, payload: order });
    expect(r.statusCode).toBe(403);
  });

  it("creates an order in the caller's tenant, idempotently, and hides it from other tenants (no IDOR)", async () => {
    const a = cookieOf(await login("admin@a.co", "correct-horse-1"));
    const first = await app.inject({ method: "POST", url: "/api/v1/orders", headers: { cookie: a, "idempotency-key": "k-00000003" }, payload: order });
    expect(first.statusCode).toBe(201);
    expect(first.json().tenantId).toBe("tA");
    expect(first.json().totalAmount).toBe(2500);
    const again = await app.inject({ method: "POST", url: "/api/v1/orders", headers: { cookie: a, "idempotency-key": "k-00000003" }, payload: order });
    expect(again.json().id).toBe(first.json().id);
    expect(db.orders.length).toBe(1);

    const b = cookieOf(await login("b@b.co", "correct-horse-3"));
    expect((await app.inject({ method: "GET", url: `/api/v1/orders/${first.json().id}`, headers: { cookie: b } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/orders/${first.json().id}`, headers: { cookie: a } })).statusCode).toBe(200);
  });

  it("rate-limits repeated login attempts on one account (429)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login("ratelimit@a.co", "wrong-password-x")).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it("verifies webhook signatures, deduplicates events and moves the order to paid exactly once", async () => {
    const o = db.orders[0];
    o.status = "confirmed";
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { metadata: { orderId: o.id } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`;
    const post = (s: string) => app.inject({ method: "POST", url: "/api/v1/webhooks/payments", headers: { "content-type": "application/json", "stripe-signature": s }, payload: body });

    expect((await post("t=1,v1=bad")).statusCode).toBe(400);
    const ok = await post(sig);
    expect(ok.statusCode).toBe(200);
    expect(o.status).toBe("paid");
    expect(db.outbox.filter((e) => e.type === "order.paid").length).toBe(1);
    const dup = await post(sig);
    expect(dup.json().duplicate).toBe(true);
    expect(db.outbox.filter((e) => e.type === "order.paid").length).toBe(1);
  });
});
