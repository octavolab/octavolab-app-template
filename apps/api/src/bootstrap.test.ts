import { describe, it, expect } from "vitest";
import argon2 from "argon2";
import { bootstrapIfRequested, DEMO_PRODUCTS } from "./bootstrap.js";

function fakeDb(existing: string[] = []) {
  const users = new Map<string, { email: string; passwordHash: string; role: string; tenantId: string }>();
  for (const e of existing) users.set(e, { email: e, passwordHash: "keep-me", role: "customer", tenantId: "demo" });
  const products: unknown[] = [];
  return {
    users, products,
    tenant: { upsert: async () => ({ id: "demo" }) },
    product: { upsert: async (a: unknown) => { products.push(a); return a; } },
    user: {
      findUnique: async (a: unknown) => users.get((a as { where: { email: string } }).where.email) ?? null,
      create: async (a: unknown) => { const d = (a as { data: { email: string; passwordHash: string; role: string; tenantId: string } }).data; users.set(d.email, d); return d; },
    },
  };
}
const logs: string[] = [];
const log = { info: (_o: object, m: string) => { logs.push(m); } };

describe("first-access bootstrap", () => {
  it("does nothing unless both variables are set", async () => {
    const db = fakeDb();
    expect(await bootstrapIfRequested(db, {}, log)).toBe("skipped");
    expect(await bootstrapIfRequested(db, { BOOTSTRAP_OWNER_EMAIL: "a@b.co" }, log)).toBe("skipped");
    expect(db.users.size + db.products.length).toBe(0);
  });

  it("creates the owner with an argon2 hash, the demo tenant and price list; never logs the password", async () => {
    const db = fakeDb();
    const pw = "a-long-password-123";
    expect(await bootstrapIfRequested(db, { BOOTSTRAP_OWNER_EMAIL: " Owner@Example.com ", BOOTSTRAP_OWNER_PASSWORD: pw }, log)).toBe("created");
    const u = db.users.get("owner@example.com")!;
    expect([u.role, u.tenantId]).toEqual(["owner", "demo"]);
    expect(u.passwordHash).not.toContain(pw);
    expect(await argon2.verify(u.passwordHash, pw)).toBe(true);
    expect(db.products.length).toBe(DEMO_PRODUCTS.length);
    expect(logs.join(" ")).not.toContain(pw);
  });

  it("never touches an existing user (idempotent, no password overwrite)", async () => {
    const db = fakeDb(["owner@example.com"]);
    expect(await bootstrapIfRequested(db, { BOOTSTRAP_OWNER_EMAIL: "owner@example.com", BOOTSTRAP_OWNER_PASSWORD: "another-long-pass" }, log)).toBe("exists");
    expect(db.users.get("owner@example.com")!.passwordHash).toBe("keep-me");
  });

  it("refuses a short password or a malformed email (fails at start, nothing written)", async () => {
    const db = fakeDb();
    await expect(bootstrapIfRequested(db, { BOOTSTRAP_OWNER_EMAIL: "owner@example.com", BOOTSTRAP_OWNER_PASSWORD: "short" }, log)).rejects.toThrow(/12 characters/);
    await expect(bootstrapIfRequested(db, { BOOTSTRAP_OWNER_EMAIL: "not-an-email", BOOTSTRAP_OWNER_PASSWORD: "a-long-password-123" }, log)).rejects.toThrow(/not an email/);
    expect(db.users.size).toBe(0);
  });
});
