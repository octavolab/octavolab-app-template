import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
const prisma = new PrismaClient();
async function main() {
  const tenant = await prisma.tenant.upsert({ where: { id: "demo" }, update: {}, create: { id: "demo", name: "Demo tenant" } });
  await prisma.user.upsert({ where: { email: "admin@example.com" }, update: {},
    create: { email: "admin@example.com", passwordHash: await argon2.hash(process.env.SEED_ADMIN_PASSWORD || (() => { throw new Error("set SEED_ADMIN_PASSWORD"); })()), role: "owner", tenantId: tenant.id } });
  // Demo price list for customer self-service (POST /api/v1/me/orders); prices in minor units. Edit with PUT /api/v1/products/:sku.
  for (const p of [{ sku: "DEMO-BOX-S", name: "Small box", unitAmount: 1500 }, { sku: "DEMO-BOX-L", name: "Large box", unitAmount: 3900 }]) {
    await prisma.product.upsert({ where: { tenantId_sku: { tenantId: tenant.id, sku: p.sku } }, update: {}, create: { ...p, currency: "GBP", tenantId: tenant.id } });
  }
}
main().finally(() => prisma.$disconnect());
