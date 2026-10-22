import argon2 from "argon2";

/**
 * First-access bootstrap for a fresh environment (staging): creates the demo tenant, its demo price list and the
 * first owner, ONLY when BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD are set and that email does not exist yet.
 * Idempotent: an existing user is never modified (its password is never overwritten). The password is typed by a
 * human in the Lightsail console or Secrets Manager, never committed, never logged; remove both variables after the
 * first sign-in. The owner must enroll 2FA at first sign-in when REQUIRE_PRIVILEGED_2FA=true.
 */
type Db = {
  tenant: { upsert(a: unknown): Promise<{ id: string }> };
  product: { upsert(a: unknown): Promise<unknown> };
  user: { findUnique(a: unknown): Promise<unknown>; create(a: unknown): Promise<unknown> };
};
type Log = { info(o: object, msg: string): void };

export const DEMO_PRODUCTS = [
  { sku: "DEMO-BOX-S", name: "Small box", unitAmount: 1500 },
  { sku: "DEMO-BOX-L", name: "Large box", unitAmount: 3900 },
] as const;

export async function bootstrapIfRequested(db: Db, source: Record<string, string | undefined>, log: Log): Promise<"skipped" | "exists" | "created"> {
  const email = source.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase();
  const password = source.BOOTSTRAP_OWNER_PASSWORD;
  if (!email || !password) return "skipped";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("BOOTSTRAP_OWNER_EMAIL is not an email");
  if (password.length < 12) throw new Error("BOOTSTRAP_OWNER_PASSWORD must have at least 12 characters");

  const tenant = await db.tenant.upsert({ where: { id: "demo" }, update: {}, create: { id: "demo", name: "Demo tenant" } });
  for (const p of DEMO_PRODUCTS) {
    await db.product.upsert({ where: { tenantId_sku: { tenantId: tenant.id, sku: p.sku } }, update: {}, create: { ...p, currency: "GBP", tenantId: tenant.id } });
  }
  if (await db.user.findUnique({ where: { email } })) {
    log.info({ event: "bootstrap_owner_exists" }, "bootstrap: owner already exists, nothing changed; remove BOOTSTRAP_OWNER_* variables");
    return "exists";
  }
  await db.user.create({ data: { email, passwordHash: await argon2.hash(password), role: "owner", tenantId: tenant.id } });
  log.info({ event: "bootstrap_owner_created" }, "bootstrap: owner created; sign in, enroll 2FA, then remove BOOTSTRAP_OWNER_* variables");
  return "created";
}
