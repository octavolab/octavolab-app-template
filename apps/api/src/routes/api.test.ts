import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import { db } from "../test-support/prisma-stand-in.js";

// Environment must be set before the app (and its env schema) is imported.
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "http://localhost:5173", OPS_EMAIL: "ops@test.invalid", RATE_LIMIT_MAX: "1000",
  INTEGRATIONS_MODE: "test", PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test",
  MESSAGING_PROVIDER: "resend", RESEND_API_KEY: "re_test_x", MESSAGING_FROM: "noreply@test.invalid", // test mode requires both real adapters (env.ts)
});

// Unit tests use the in-memory rate-limit store even where CI exports REDIS_URL; the Redis store is covered by
// test/integration/rate-limit-redis.int.test.ts against the CI Redis service.
delete process.env.REDIS_URL;

// In-memory stand-in for Prisma (shared with the other API test files): auth, tenancy, idempotency, webhook dedupe end to end.
vi.mock("@octavolab/db", async () => (await import("../test-support/prisma-stand-in.js")).dbModule);

// Stripe API stand-in (sandbox mode uses the real StripeGateway): honours Idempotency-Key like Stripe does.
const stripe = vi.hoisted(() => ({ calls: [] as { method: string; url: string; body: URLSearchParams | null; key: string | undefined }[], byKey: new Map<string, string>() }));
vi.stubGlobal("fetch", async (url: string, init: any) => {
  const key = init.headers["Idempotency-Key"];
  stripe.calls.push({ method: init.method, url, body: init.body ? new URLSearchParams(String(init.body)) : null, key });
  let id = url.split("/").pop()!;
  if (init.method === "POST") { id = (key && stripe.byKey.get(key)) ?? `pi_test_${stripe.byKey.size + 1}`; if (key) stripe.byKey.set(key, id); }
  return new Response(JSON.stringify({ id, client_secret: `${id}_secret_abc`, status: "requires_payment_method" }), { status: 200 });
});

let app: any;
let buildApp: any;
const cookieOf = (res: any): string => String(res.headers["set-cookie"]).split(";")[0] ?? "";

beforeAll(async () => {
  db.users.push(
    { id: "u-admin", email: "admin@a.co", role: "admin", tenantId: "tA", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-1") },
    { id: "u-cust", email: "c@a.co", role: "customer", tenantId: "tA", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-2") },
    { id: "u-b", email: "b@b.co", role: "admin", tenantId: "tB", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-3") },
    { id: "u-owner", email: "owner@a.co", role: "owner", tenantId: "tA", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-4") },
    { id: "u-ops", email: "ops@a.co", role: "operations", tenantId: "tA", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-5") },
    { id: "u-gone", email: "gone@a.co", role: "admin", tenantId: "tA", sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-6") },
    { id: "u-none", email: "none@x.co", role: "admin", tenantId: null, sessionVersion: 0, passwordHash: await argon2.hash("correct-horse-7") },
  );
  ({ buildApp } = await import("../app.js"));
  app = await buildApp();
});

// Each sign-in comes from its own client IP so the per (email, IP) login limit only triggers in the test that targets it.
let ipSeq = 0;
const login = async (email: string, password: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` }, payload: { email, password } });
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

  it("a user without a tenant cannot create or read orders (403), never a shared null tenant", async () => {
    const n = cookieOf(await login("none@x.co", "correct-horse-7"));
    const created = await app.inject({ method: "POST", url: "/api/v1/orders", headers: { cookie: n, "idempotency-key": "k-notenant-1" }, payload: order });
    expect(created.statusCode).toBe(403);
    expect(created.json().code).toBe("TENANT_REQUIRED");
    expect((await app.inject({ method: "GET", url: `/api/v1/orders/${db.orders[0].id}`, headers: { cookie: n } })).statusCode).toBe(403);
  });

  it("rejects an Idempotency-Key reused with a different body (422)", async () => {
    const a = cookieOf(await login("admin@a.co", "correct-horse-1"));
    const other = { ...order, items: [{ sku: "B", qty: 1, unitAmount: 999 }] };
    const r = await app.inject({ method: "POST", url: "/api/v1/orders", headers: { cookie: a, "idempotency-key": "k-00000003" }, payload: other });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("IDEMPOTENCY_MISMATCH");
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

  it("caps login attempts per account across rotating IPs (distributed guessing gets 429)", async () => {
    const attempt = (ip: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": ip }, payload: { email: "spray@a.co", password: "wrong-password-x" } });
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await attempt(`10.1.${Math.floor(i / 4)}.${i % 4}`)).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
    expect(codes[30]).toBe(429);
    // Another account is unaffected.
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": "10.9.9.9" }, payload: { email: "other@a.co", password: "wrong-password-x" } })).statusCode).toBe(401);
  });

  it("audits a succeeded payment that arrives while the order is not payable (draft), instead of dropping it", async () => {
    const o = db.orders[0];
    const prev = o.status; o.status = "draft";
    const body = JSON.stringify({ id: "evt_draft_1", type: "payment_intent.succeeded", data: { object: { status: "succeeded", amount: o.totalAmount, amount_received: o.totalAmount, currency: o.currency.toLowerCase(), metadata: { orderId: o.id } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`;
    const r = await app.inject({ method: "POST", url: "/api/v1/webhooks/payments", headers: { "content-type": "application/json", "stripe-signature": sig }, payload: body });
    expect(r.statusCode).toBe(200);
    expect(o.status).toBe("draft");
    expect(db.audit.some((a: any) => a.action === "payment_unapplied" && a.entityId === o.id)).toBe(true);
    o.status = prev;
  });

  it("health reports redis as not_configured when REDIS_URL is unset", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.json().deps.redis).toBe("not_configured");
  });

  it("verifies webhook signatures, deduplicates events and moves the order to paid exactly once", async () => {
    const o = db.orders[0];
    o.status = "confirmed";
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { status: "succeeded", amount: o.totalAmount, amount_received: o.totalAmount, currency: "usd", metadata: { orderId: o.id } } } });
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
    const body = JSON.stringify({ id: "evt_2", type: "payment_intent.succeeded", data: { object: { status: "succeeded", amount: 1, amount_received: 1, currency: "usd", metadata: { orderId: o.id } } } });
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
    const body = JSON.stringify({ id: "evt_3", type: "payment_intent.succeeded", data: { object: { status: "succeeded", amount: o.totalAmount, amount_received: o.totalAmount, currency: "usd", metadata: { orderId: o.id } } } });
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
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: c } });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toMatch(/@/); // the web header shows who is signed in after a reload
    // CSP: Stripe Elements allowed, everything else stays 'self'; framing is never allowed.
    const csp = String(me.headers["content-security-policy"]);
    expect(csp).toContain("script-src 'self' https://js.stripe.com");
    expect(csp).toContain("connect-src 'self' https://api.stripe.com");
    expect(csp).toContain("frame-ancestors 'none'");
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

const signed = (event: object) => {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  return { body, sig: `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}` };
};
const postWebhook = (event: object) => { const { body, sig } = signed(event); return app.inject({ method: "POST", url: "/api/v1/webhooks/payments", headers: { "content-type": "application/json", "stripe-signature": sig }, payload: body }); };

describe("checkout: draft -> pending_payment -> paid", () => {
  let admin: string; let orderId: string;
  const checkout = (id: string, key: string, cookie = admin) => app.inject({ method: "POST", url: `/api/v1/orders/${id}/checkout`, headers: { cookie, "idempotency-key": key } });

  beforeAll(async () => {
    admin = cookieOf(await login("admin@a.co", "correct-horse-1"));
    const created = await app.inject({ method: "POST", url: "/api/v1/orders", headers: { cookie: admin, "idempotency-key": "k-checkout-order-1" }, payload: { customerEmail: "p@y.co", currency: "GBP", items: [{ sku: "C", qty: 3, unitAmount: 1999 }] } });
    orderId = created.json().id;
    stripe.calls.length = 0;
  });

  it("moves a draft order to pending_payment and creates one provider intent in integer minor units", async () => {
    const r = await checkout(orderId, "k-pay-00000001");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ orderId, status: "pending_payment", paymentIntentId: "pi_test_1", amount: 5997, currency: "GBP", clientSecret: "pi_test_1_secret_abc" });
    const o = db.orders.find((x) => x.id === orderId);
    expect([o.status, o.paymentIntentId]).toEqual(["pending_payment", "pi_test_1"]);
    const create = stripe.calls.filter((c) => c.method === "POST");
    expect(create.length).toBe(1);
    expect([create[0]!.body!.get("amount"), create[0]!.body!.get("currency"), create[0]!.body!.get("metadata[orderId]"), create[0]!.key]).toEqual(["5997", "gbp", orderId, `checkout:${orderId}`]);
    expect(db.audit.some((a) => a.action === "checkout_started" && a.entityId === orderId)).toBe(true);
    expect([...db.keys.values()].some((k) => k.response.includes("secret"))).toBe(false); // the client secret is never stored
  });

  it("is idempotent: same key replays, a new key resumes the same intent, another body is rejected", async () => {
    const replay = await checkout(orderId, "k-pay-00000001");
    expect(replay.statusCode).toBe(200);
    expect(replay.json().paymentIntentId).toBe("pi_test_1");
    expect(replay.json().clientSecret).toBe("pi_test_1_secret_abc");
    const resumed = await checkout(orderId, "k-pay-00000002");
    expect(resumed.json().paymentIntentId).toBe("pi_test_1");
    expect(stripe.calls.filter((c) => c.method === "POST").length).toBe(1); // no second intent
    const mismatch = await checkout(db.orders[0].id, "k-pay-00000001");
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("is tenant-scoped and staff-only, and refuses orders that cannot start checkout", async () => {
    const b = cookieOf(await login("b@b.co", "correct-horse-3"));
    expect((await checkout(orderId, "k-pay-other-tenant", b)).statusCode).toBe(404);
    const c = cookieOf(await login("c@a.co", "correct-horse-2"));
    expect((await checkout(orderId, "k-pay-customer-1", c)).statusCode).toBe(403);
    const n = cookieOf(await login("none@x.co", "correct-horse-7"));
    expect((await checkout(orderId, "k-pay-no-tenant", n)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/checkout`, headers: { cookie: admin } })).statusCode).toBe(400); // Idempotency-Key required
    expect((await app.inject({ method: "POST", url: `/api/v1/orders/${orderId}/checkout`, headers: { "idempotency-key": "k-pay-anon-001" } })).statusCode).toBe(401);
    const paid = db.orders[0]; // paid by the webhook tests above
    expect(paid.status).toBe("paid");
    const r = await checkout(paid.id, "k-pay-paid-0001");
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("INVALID_STATE");
  });

  it("the webhook ignores an intent that is not succeeded, not fully received, or not the order's intent", async () => {
    const o = db.orders.find((x) => x.id === orderId);
    const base = { status: "succeeded", id: "pi_test_1", amount: 5997, amount_received: 5997, currency: "gbp", metadata: { orderId } };
    for (const [i, override] of [{ status: "processing" }, { amount_received: 100 }, { id: "pi_someone_else" }, { currency: "usd" }].entries()) {
      const r = await postWebhook({ id: `evt_chk_bad_${i}`, type: "payment_intent.succeeded", data: { object: { ...base, ...override } } });
      expect(r.statusCode).toBe(200);
      expect(o.status).toBe("pending_payment");
    }
    expect(db.audit.filter((a) => a.action === "payment_mismatch" && a.entityId === orderId).length).toBe(4);
  });

  it("the signed webhook moves pending_payment -> paid exactly once", async () => {
    const o = db.orders.find((x) => x.id === orderId);
    const event = { id: "evt_chk_ok", type: "payment_intent.succeeded", data: { object: { id: "pi_test_1", status: "succeeded", amount: 5997, amount_received: 5997, currency: "gbp", metadata: { orderId } } } };
    expect((await postWebhook(event)).statusCode).toBe(200);
    expect(o.status).toBe("paid");
    expect((await postWebhook(event)).json().duplicate).toBe(true);
    expect(db.outbox.filter((e) => e.type === "order.paid" && e.payload.orderId === orderId).length).toBe(1);
  });
});

describe("OpenAPI", () => {
  it("documents the checkout endpoint and docs/openapi.json is up to date (UPDATE_OPENAPI=1 regenerates it)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.paths["/api/v1/orders/{id}/checkout"].post.summary).toMatch(/pending_payment/);
    expect(spec.paths["/api/v1/users/{id}/role"].patch).toBeDefined();
    expect(spec.paths["/api/v1/me/orders/{id}/checkout"].post.summary).toMatch(/pending_payment/);
    expect(spec.paths["/api/v1/me/orders"].post.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
    for (const p of ["/api/v1/auth/login/mfa", "/api/v1/auth/2fa/enroll", "/api/v1/auth/2fa/activate", "/api/v1/auth/2fa/disable", "/api/v1/auth/2fa/recovery-codes", "/api/v1/users/{id}/2fa/reset"]) {
      expect(spec.paths[p].post, p).toBeDefined();
    }
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../docs/openapi.json");
    const text = `${JSON.stringify(spec, null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI === "1") writeFileSync(file, text);
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});
