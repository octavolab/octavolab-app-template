-- Server-side session revocation: logout and role changes increment User.sessionVersion; tokens carry it as `sv`.
-- Written by hand from schema.prisma (Prisma engine download blocked in the authoring environment); CI checks drift with
-- `prisma migrate diff --exit-code`.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
