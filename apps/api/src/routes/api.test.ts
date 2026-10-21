import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import argon2 from "argon2";

// Environment must be set before the app (and its env schema) is imported.
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "http://localhost:5173", OPS_EMAIL: "ops@test.invalid",
  INTEGRATIONS_MODE: "sandbox", PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test",
});

// Unit tests use the in-memory rate-limit store even where CI exports REDIS_URL; the Redis store is covered by
// test/integration/rate-limit-redis.int.test.ts against the CI Redis service.
delete process.env.REDIS_URL;

// In-memory stand-in for Prisma: enough behaviour to exercise auth, tenancy, idempotency and webhook dedupe end to end.
const db = vi.hoisted(() => ({ users: [] as any[], orders: [] as any[], keys: new Map<string, string>(), events: new Set<string>(), audit: [] as any[], outbox: [] as any[], failNextOutbox: false }));
vi.mock("@octavolab/db", () => {
  class PrismaClientKnownRequestError extends Error { constructor(public code: string) { super(code); } }
  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) => db.users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) ?? null,
      updateMany: async ({ where, data }: any) => {
        const u = db.users.find((x) => x.id === where.id && (where.tenantId === undefined || x.tenantId === where.tenantId));
        if (!u) return { count: 0 };
        if (data.role) u.role = data.role;
        if (data.sessionVersion?.increment) u.sessionVersion += data.sessionVersion.increment;
        return { count: 1 };
      },
    },
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
    outbox: { create: async ({ data }: any) => { if (db.failNextOutbox) { db.failNextOutbox = false; throw new Error("injected failure"); } db.outbox.push(data); return data; } },
    webhookEvent: { create: async ({ data }: any) => { if (db.events.has(data.id)) throw new PrismaClientKnownRequestError("P2002"); db.events.add(data.id); return data; } },
    // Snapshot and restore on error: enough to model rollback of events, orders, audit and outbox.
    $transaction: async (fn: any) => {
      const snap = { events: new Set(db.events), orders: db.orders.map((o) => ({ ...o })), audit: [...db.audit], outbox: [...db.outbox] };
      try { return await fn(prisma); } catch (e) {
        db.events = snap.events; db.audit = snap.audit; db.outbox = snap.outbox;
        snap.orders.forEach((s, i) => Object.assign(db.orders[i], s));
        throw e;
      }
    },
    $queryRaw: async () => [{ 1: 1 }],
  };
  return { prisma, Prisma: { PrismaClientKnownRequestError } };
});

let app: any;
let buildApp: any;
const cookieOf = (res: any) => String(res.headers["set-cookie"]).split(";")[0];

beforeAll(async () => {
  db.users.push(
    { id: "u-admin", email: "admin@a.co", role: "admin", tenantId: "tA", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-1") },
    { id: "u-cust", email: "c@a.co", role: "customer", tenantId: "tA", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-2") },
    { id: "u-b", email: "b@b.co", role: "admin", tenantId: "tB", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-3") },
    { id: "u-owner", email: "owner@a.co", role: "owner", tenantId: "tA", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-4") },
    { id: "u-ops", email: "ops@a.co", role: "operations", tenantId: "tA", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-5") },
    { id: "u-gone", email: "gone@a.co", role: "admin", tenantId: "tA", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-6") },
  );
  ({ buildApp } = await import("../app.js"));
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

  it("rate-limits repeated login attempts on one account from one IP (429) without locking the account out elsewhere", async () => {
    const attempt = (ip: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": ip }, payload: { email: "ratelimit@a.co", password: "wrong-password-x" } });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await attempt("10.0.0.1")).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
    // Key is email + IP: the owner of the account, from their own IP, is not locked out by an attacker (lockout DoS).
    expect((await attempt("10.0.0.2")).statusCode).toBe(401);
  });

  it("verifies webhook signatures, deduplicates events and moves the order to paid exactly once", async () => {
    const o = db.orders[0];
    o.status = "confirmed";
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { amount: o.totalAmount, currency: "usd", metadata: { orderId: o.id } } } });
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

  it("does not mark an order paid when amount or currency differ, and audits the mismatch", async () => {
    const o = db.orders[0];
    o.status = "confirmed";
    const body = JSON.stringify({ id: "evt_2", type: "payment_intent.succeeded", data: { object: { amount: 1, currency: "usd", metadata: { orderId: o.id } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`;
    const r = await app.inject({ method: "POST", url: "/api/v1/webhooks/payments", headers: { "content-type": "application/json", "stripe-signature": sig }, payload: body });
    expect(r.statusCode).toBe(200);
    expect(o.status).toBe("confirmed");
    expect(db.audit.some((a) => a.action === "payment_mismatch")).toBe(true);
  });

  it("rolls back the event record when the transaction fails, so the provider retry is processed", async () => {
    const o = db.orders[0];
    o.status = "confirmed";
    const body = JSON.stringify({ id: "evt_3", type: "payment_intent.succeeded", data: { object: { amount: o.totalAmount, currency: "usd", metadata: { orderId: o.id } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`;
    db.failNextOutbox = true;
    const first = await app.inject({ method: "POST", url: "/api/v1/webhooks/payments", headers: { "content-type": "application/json", "stripe-signature": sig }, payload: body });
    expect(first.statusCode).toBe(500);
    expect(db.events.has("evt_3")).toBe(false);
    const retry = await app.inject({ method: "POST", url: "/api/v1/webhooks/payments", headers: { "content-type": "application/json", "stripe-signature": sig }, payload: body });
    expect(retry.statusCode).toBe(200);
    expect(o.status).toBe("paid");
  });
});

describe("sessions: server-side revocation, audit and security logs", () => {
  it("logout revokes the session server-side: the old cookie no longer works", async () => {
    const c = cookieOf(await login("ops@a.co", "correct-horse-5"));
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: c } })).statusCode).toBe(200);
    const out = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: c } });
    expect(out.statusCode).toBe(200);
    const replay = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: c } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe("SESSION_REVOKED");
    expect(db.audit.some((a) => a.action === "login" && a.entityId === "u-ops")).toBe(true);
    expect(db.audit.some((a) => a.action === "logout" && a.entityId === "u-ops")).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout" })).statusCode).toBe(200); // no cookie: idempotent
  });

  it("a role change revokes the target's sessions immediately and is audited", async () => {
    const target = cookieOf(await login("admin@a.co", "correct-horse-1"));
    const owner = cookieOf(await login("owner@a.co", "correct-horse-4"));
    const r = await app.inject({ method: "PATCH", url: "/api/v1/users/u-admin/role", headers: { cookie: owner }, payload: { role: "operations" } });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: target } })).statusCode).toBe(401);
    expect(db.audit.some((a) => a.action === "role_change" && a.entityId === "u-admin")).toBe(true);
    const fresh = cookieOf(await login("admin@a.co", "correct-horse-1"));
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: fresh } })).json().role).toBe("operations");
    // restore for later tests
    expect((await app.inject({ method: "PATCH", url: "/api/v1/users/u-admin/role", headers: { cookie: owner }, payload: { role: "admin" } })).statusCode).toBe(200);
  });

  it("role changes are owner-only, tenant-scoped and never self-applied", async () => {
    const owner = cookieOf(await login("owner@a.co", "correct-horse-4"));
    const admin = cookieOf(await login("admin@a.co", "correct-horse-1"));
    expect((await app.inject({ method: "PATCH", url: "/api/v1/users/u-cust/role", headers: { cookie: admin }, payload: { role: "admin" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/users/u-b/role", headers: { cookie: owner }, payload: { role: "customer" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/users/u-owner/role", headers: { cookie: owner }, payload: { role: "customer" } })).statusCode).toBe(409);
  });

  it("rejects a valid token whose user was deleted, or whose role or tenant no longer match", async () => {
    const c = cookieOf(await login("gone@a.co", "correct-horse-6"));
    const u = db.users.find((x) => x.id === "u-gone");
    u.tenantId = "tB";
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: c } })).statusCode).toBe(401);
    u.tenantId = "tA"; u.role = "owner";
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: c } })).statusCode).toBe(401);
    db.users.splice(db.users.indexOf(u), 1);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: c } })).statusCode).toBe(401);
  });

  it("logs login_failed with an email fingerprint, never the email or the password", async () => {
    const lines: string[] = [];
    const logged = await buildApp({ logStream: { write: (l: string) => lines.push(l) } });
    await logged.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "Victim@a.co", password: "secret-password-9" } });
    await logged.close();
    const failed = lines.map((l) => JSON.parse(l)).find((l) => l.event === "login_failed");
    expect(failed.emailHash).toMatch(/^[0-9a-f]{16}$/);
    expect(failed.reason).toBe("unknown_account");
    const all = lines.join("\n").toLowerCase();
    expect(all).not.toContain("victim@a.co");
    expect(all).not.toContain("secret-password-9");
  });

  it("reuses a safe client x-request-id and replaces an unsafe one", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/health", headers: { "x-request-id": "abc-123_DEF" } });
    expect(ok.headers["x-request-id"]).toBe("abc-123_DEF");
    const bad = await app.inject({ method: "GET", url: "/api/health", headers: { "x-request-id": "evil\ninjected log line" } });
    expect(bad.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const long = await app.inject({ method: "GET", url: "/api/health", headers: { "x-request-id": "a".repeat(65) } });
    expect(long.headers["x-request-id"]).not.toBe("a".repeat(65));
  });
});
