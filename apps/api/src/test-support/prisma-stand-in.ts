/**
 * In-memory stand-in for the Prisma client, shared by the API test files (the Prisma engines cannot be downloaded in
 * the authoring sandbox; database semantics are proven by test/integration against PostgreSQL in CI).
 *
 * Usage in a test file:
 *   vi.mock("@octavolab/db", async () => (await import("../test-support/prisma-stand-in.js")).dbModule);
 *   import { db } from "../test-support/prisma-stand-in.js";
 *
 * It models just enough of Prisma for the services: equality, `in`, `lt`, `OR` and compound unique filters, `increment`
 * updates, unique violations (P2002) and transaction rollback (rows restored in place, so test references stay valid).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a loosely typed test double for the generated Prisma client */

type Row = Record<string, any>;
type Where = Record<string, any> | undefined;

export class PrismaClientKnownRequestError extends Error {
  constructor(public code: string) { super(code); }
}

export const db = {
  users: [] as any[],
  orders: [] as any[],
  products: [] as any[],
  recoveryCodes: [] as any[],
  audit: [] as any[],
  outbox: [] as any[],
  keys: new Map<string, { response: string; requestHash: string }>(),
  events: new Set<string>(),
  failNextOutbox: false,
  seq: 0,
};

const COMPOUND: Record<string, string[]> = { tenantId_sku: ["tenantId", "sku"] };

export function matches(row: Row, where: Where): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue; // Prisma ignores undefined filters
    if (k === "OR") { if (!(v as Where[]).some((w) => matches(row, w))) return false; continue; }
    if (k === "AND") { if (!(v as Where[]).every((w) => matches(row, w))) return false; continue; }
    if (COMPOUND[k]) { if (!COMPOUND[k]!.every((f) => row[f] === v[f])) return false; continue; }
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v && !v.in.includes(row[k])) return false;
      if ("lt" in v && !(row[k] !== null && row[k] !== undefined && row[k] < v.lt)) return false;
      if ("not" in v && (row[k] ?? null) === v.not) return false;
      continue;
    }
    if ((row[k] ?? null) !== v) return false;
  }
  return true;
}

const copy = (r: Row | undefined) => (r ? { ...r } : null);

function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === "object" && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
    else row[k] = v;
  }
}

function assertUnique(table: Row[], row: Row, fields: string[][]) {
  for (const f of fields) {
    if (f.some((x) => row[x] === null || row[x] === undefined)) continue;
    if (table.some((o) => o !== row && f.every((x) => o[x] === row[x]))) throw new PrismaClientKnownRequestError("P2002");
  }
}

function model(table: () => Row[], opts: { prefix: string; unique?: string[][]; defaults?: () => Row; create?: (data: Row) => Row }) {
  const unique = opts.unique ?? [];
  return {
    // Reads return copies, like Prisma: a later update must not change an object the service already holds.
    findUnique: async ({ where }: any) => copy(table().find((r) => matches(r, where))),
    findFirst: async ({ where }: any) => copy(table().find((r) => matches(r, where))),
    findMany: async ({ where, orderBy, take, cursor, skip }: any = {}) => {
      let rows = table().filter((r) => matches(r, where));
      const order = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, "asc" | "desc">[];
      rows = [...rows].sort((a, b) => {
        for (const o of order) {
          const [k, dir] = Object.entries(o)[0]!;
          const av = a[k] instanceof Date ? a[k].getTime() : a[k];
          const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
          if (av !== bv) return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
        }
        return 0;
      });
      if (cursor) { const i = rows.findIndex((r) => r.id === cursor.id); rows = i < 0 ? [] : rows.slice(i); }
      if (skip) rows = rows.slice(skip);
      return (take === undefined ? rows : rows.slice(0, take)).map((r) => ({ ...r }));
    },
    count: async ({ where }: any = {}) => table().filter((r) => matches(r, where)).length,
    create: async ({ data }: any) => {
      const row: Row = { id: `${opts.prefix}${++db.seq}`, ...(opts.defaults?.() ?? {}), ...(opts.create ? opts.create(data) : data) };
      assertUnique(table(), row, unique);
      table().push(row);
      return row;
    },
    createMany: async ({ data }: any) => {
      for (const d of data as Row[]) { const row = { id: `${opts.prefix}${++db.seq}`, ...(opts.defaults?.() ?? {}), ...d }; assertUnique(table(), row, unique); table().push(row); }
      return { count: (data as Row[]).length };
    },
    update: async ({ where, data }: any) => {
      const row = table().find((r) => matches(r, where));
      if (!row) throw new PrismaClientKnownRequestError("P2025");
      const before = { ...row };
      apply(row, data);
      try { assertUnique(table(), row, unique); } catch (e) { Object.assign(row, before); throw e; }
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const rows = table().filter((r) => matches(r, where));
      for (const row of rows) {
        const before = { ...row };
        apply(row, data);
        try { assertUnique(table(), row, unique); } catch (e) { Object.assign(row, before); throw e; }
      }
      return { count: rows.length };
    },
    upsert: async ({ where, create, update }: any) => {
      const row = table().find((r) => matches(r, where));
      if (row) { apply(row, update); return row; }
      const created: Row = { id: `${opts.prefix}${++db.seq}`, ...(opts.defaults?.() ?? {}), ...create };
      assertUnique(table(), created, unique);
      table().push(created);
      return created;
    },
    deleteMany: async ({ where }: any = {}) => {
      const keep = table().filter((r) => !matches(r, where));
      const count = table().length - keep.length;
      table().splice(0, table().length, ...keep);
      return { count };
    },
  };
}

const now = () => new Date(1_790_000_000_000 + db.seq * 1000);

export const prisma: any = {
  user: model(() => db.users, { prefix: "u", unique: [["email"]], defaults: () => ({ sessionVersion: 0, totpSecret: null, totpEnabledAt: null, totpLastStep: null }) }),
  order: model(() => db.orders, {
    prefix: "o", unique: [["paymentIntentId"]],
    defaults: () => ({ version: 0, paymentIntentId: null, customerUserId: null, createdAt: now() }),
    create: (data) => ({ ...data, items: data.items?.create ?? [] }),
  }),
  product: model(() => db.products, { prefix: "p", unique: [["tenantId", "sku"]], defaults: () => ({ active: true, createdAt: now() }) }),
  mfaRecoveryCode: model(() => db.recoveryCodes, { prefix: "rc", defaults: () => ({ usedAt: null, createdAt: now() }) }),
  idempotencyKey: {
    findUnique: async ({ where }: any) => db.keys.get(where.key) ?? null,
    create: async ({ data }: any) => {
      if (db.keys.has(data.key)) throw new PrismaClientKnownRequestError("P2002");
      db.keys.set(data.key, { response: data.response, requestHash: data.requestHash });
      return data;
    },
  },
  auditLog: { create: async ({ data }: any) => { db.audit.push(data); return data; } },
  outbox: { create: async ({ data }: any) => { if (db.failNextOutbox) { db.failNextOutbox = false; throw new Error("injected failure"); } db.outbox.push(data); return data; } },
  webhookEvent: { create: async ({ data }: any) => { if (db.events.has(data.id)) throw new PrismaClientKnownRequestError("P2002"); db.events.add(data.id); return data; } },
  // Snapshot and restore on error: rows changed in the transaction get their old fields back (same object, so test
  // references stay valid) and rows created in it are removed.
  $transaction: async (fn: any) => {
    const tables = [db.users, db.orders, db.products, db.recoveryCodes, db.audit, db.outbox];
    const snap = tables.map((t) => t.map((r) => ({ ref: r, copy: { ...r } })));
    const events = new Set(db.events);
    const keys = new Map(db.keys);
    try { return await fn(prisma); } catch (e) {
      tables.forEach((t, i) => {
        const rows = snap[i]!;
        for (const { ref, copy } of rows) { for (const k of Object.keys(ref)) delete ref[k]; Object.assign(ref, copy); }
        t.splice(0, t.length, ...rows.map((r) => r.ref));
      });
      db.events = events; db.keys = keys;
      throw e;
    }
  },
  $queryRaw: async () => [{ 1: 1 }],
};

export const dbModule = { prisma, Prisma: { PrismaClientKnownRequestError } };
