import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
const prisma = new PrismaClient();
async function main() {
  const tenant = await prisma.tenant.upsert({ where: { id: "demo" }, update: {}, create: { id: "demo", name: "Demo tenant" } });
  await prisma.user.upsert({ where: { email: "admin@example.com" }, update: {},
    create: { email: "admin@example.com", passwordHash: await argon2.hash(process.env.SEED_ADMIN_PASSWORD || (() => { throw new Error("set SEED_ADMIN_PASSWORD"); })()), role: "owner", tenantId: tenant.id } });
}
main().finally(() => prisma.$disconnect());
