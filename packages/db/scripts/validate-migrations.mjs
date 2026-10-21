// Applies every prisma/migrations/*/migration.sql in order to an empty in-process PostgreSQL (PGlite) and prints the
// resulting tables and columns. Catches syntax errors, ordering mistakes and broken constraints in hand-written SQL.
// It does not replace `prisma migrate diff --exit-code` (CI), which checks the SQL against schema.prisma.
// Usage: pnpm --filter @octavolab/db validate:sql
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations");
const migrations = readdirSync(dir).filter((d) => statSync(path.join(dir, d)).isDirectory()).sort();
const db = new PGlite();

for (const m of migrations) {
  const sql = readFileSync(path.join(dir, m, "migration.sql"), "utf8");
  // Prisma applies each migration file in its own transaction; mirror that.
  await db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
  console.log(`applied ${m}`);
}

const cols = await db.query(
  `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
);
const byTable = new Map();
for (const c of cols.rows) {
  const list = byTable.get(c.table_name) ?? [];
  list.push(`${c.column_name}${c.is_nullable === "NO" ? "" : "?"}`);
  byTable.set(c.table_name, list);
}
for (const [t, list] of byTable) console.log(`${t}: ${list.join(", ")}`);
const enums = await db.query(`SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname ORDER BY t.typname`);
for (const e of enums.rows) console.log(`enum ${e.typname}: ${e.labels}`);
console.log(`OK: ${migrations.length} migrations applied in order`);
await db.close();
