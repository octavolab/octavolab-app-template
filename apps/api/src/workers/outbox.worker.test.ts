import { describe, it, expect, vi, beforeAll } from "vitest";
import { MessagingError, type MessagingProvider } from "@octavolab/integrations";

Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "http://localhost:5173", OPS_EMAIL: "ops@test.invalid" });
vi.mock("@octavolab/db", () => ({ prisma: {}, Prisma: {} }));

type Row = { id: string; type: string; payload: unknown; attempts: number; deliveredAt?: Date | null; deadLetteredAt?: Date | null; lastError?: string | null; lockedUntil?: Date | null };

/** In-memory outbox table: claim returns pending rows; update applies the data like Prisma would. */
function fakeDb(rows: Row[]) {
  return {
    rows,
    $queryRaw: vi.fn(async () => rows.filter((r) => !r.deliveredAt && !r.deadLetteredAt && r.attempts < 8).map(({ id, type, payload, attempts }) => ({ id, type, payload, attempts }))),
    outbox: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = rows.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          if (k === "attempts") r.attempts += (v as { increment: number }).increment;
          else (r as Record<string, unknown>)[k] = v;
        }
        return r;
      }),
    },
  };
}

/** Fake messaging adapter that records sends and can be told to fail. */
function fakeMessaging(fail: boolean | Error = false) {
  const sent: { to: string; template: string; data: Record<string, unknown>; idempotencyKey?: string | undefined }[] = [];
  const adapter: MessagingProvider = { name: "test-messaging", send: async (i) => { if (fail) throw fail instanceof Error ? fail : new Error("provider 503"); sent.push(i); return { providerRef: `m${sent.length}` }; } };
  return { adapter, sent };
}

let worker: typeof import("./outbox.worker.js");
beforeAll(async () => { worker = await import("./outbox.worker.js"); });

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const deps = (db: ReturnType<typeof fakeDb>, m: ReturnType<typeof fakeMessaging>, l = log()) =>
  ({ db: db as never, messaging: () => m.adapter, opsEmail: "ops@test.invalid", log: l, handlers: worker.handlers, now: () => new Date(1_000_000) });

describe("outbox dispatchOnce", () => {
  it("routes each event type to its handler and sends to OPS_EMAIL from the environment", async () => {
    const db = fakeDb([{ id: "e1", type: "order.created", payload: { orderId: "o1" }, attempts: 0 }, { id: "e2", type: "order.paid", payload: { orderId: "o1" }, attempts: 0 }]);
    const m = fakeMessaging();
    expect(await worker.dispatchOnce(deps(db, m))).toEqual({ delivered: 2, failed: 0, deadLettered: 0 });
    expect(m.sent.map((s) => [s.to, s.template])).toEqual([["ops@test.invalid", "order_created"], ["ops@test.invalid", "order_paid"]]);
    expect(db.rows.every((r) => r.deliveredAt && r.attempts === 1)).toBe(true);
    expect(worker.defaultDeps().opsEmail).toBe("ops@test.invalid");
  });

  it("never marks an unknown event type delivered: lastError is set and it backs off", async () => {
    const db = fakeDb([{ id: "e3", type: "order.mystery", payload: {}, attempts: 0 }]);
    const l = log();
    expect(await worker.dispatchOnce(deps(db, fakeMessaging(), l))).toEqual({ delivered: 0, failed: 1, deadLettered: 0 });
    const r = db.rows[0]!;
    expect(r.deliveredAt).toBeUndefined();
    expect(r.lastError).toContain('no handler for outbox event type "order.mystery"');
    expect(r.lockedUntil).toEqual(new Date(1_000_000 + 5000));
    expect(l.warn).toHaveBeenCalled();
  });

  it("retries provider failures with exponential backoff and dead-letters at the maximum attempts with an error log", async () => {
    const db = fakeDb([{ id: "e4", type: "order.created", payload: { orderId: "o4" }, attempts: 6 }]);
    const l = log();
    expect((await worker.dispatchOnce(deps(db, fakeMessaging(true), l))).failed).toBe(1);
    expect(db.rows[0]!.lockedUntil).toEqual(new Date(1_000_000 + 5000 * 2 ** 6));
    expect(db.rows[0]!.deadLetteredAt).toBeUndefined();

    expect((await worker.dispatchOnce(deps(db, fakeMessaging(true), l))).deadLettered).toBe(1);
    const r = db.rows[0]!;
    expect(r.attempts).toBe(worker.MAX_ATTEMPTS);
    expect(r.deadLetteredAt).toEqual(new Date(1_000_000));
    expect(r.deliveredAt).toBeUndefined();
    expect(r.lastError).toBe("provider 503");
    expect(l.error).toHaveBeenCalledWith(expect.objectContaining({ event: "outbox_dead_letter", metric: "outbox_dead_letter_total", outboxId: "e4", attempts: 8 }), "outbox event dead-lettered");

    // A dead-lettered event is not claimed again.
    expect(await worker.dispatchOnce(deps(db, fakeMessaging(), l))).toEqual({ delivered: 0, failed: 0, deadLettered: 0 });
  });

  it("passes outbox:<eventId> as the provider idempotency key, so a retried send is not delivered twice", async () => {
    const db = fakeDb([{ id: "e7", type: "order.paid", payload: { orderId: "o7" }, attempts: 2 }]);
    const m = fakeMessaging();
    await worker.dispatchOnce(deps(db, m));
    expect(m.sent[0]!.idempotencyKey).toBe("outbox:e7");
  });

  it("dead-letters at once an error that says a retry cannot help (MessagingError retryable=false)", async () => {
    const db = fakeDb([{ id: "e8", type: "order.created", payload: { orderId: "o8" }, attempts: 0 }]);
    const l = log();
    const r = await worker.dispatchOnce(deps(db, fakeMessaging(new MessagingError("resend 422 validation_error", "rejected", false, 422)), l));
    expect(r).toEqual({ delivered: 0, failed: 0, deadLettered: 1 });
    expect(db.rows[0]!.deadLetteredAt).toEqual(new Date(1_000_000));
    expect(l.error).toHaveBeenCalledWith(expect.objectContaining({ event: "outbox_dead_letter", outboxId: "e8", attempts: 1, permanent: true }), "outbox event dead-lettered");
  });

  it("backs off (does not dead-letter) a retryable provider error such as a 429 or a timeout", async () => {
    const db = fakeDb([{ id: "e9", type: "order.created", payload: { orderId: "o9" }, attempts: 0 }]);
    const r = await worker.dispatchOnce(deps(db, fakeMessaging(new MessagingError("resend 429 rate_limit_exceeded", "rate_limited", true, 429))));
    expect(r).toEqual({ delivered: 0, failed: 1, deadLettered: 0 });
    expect(db.rows[0]!.lastError).toBe("resend 429 rate_limit_exceeded");
    expect(db.rows[0]!.deadLetteredAt).toBeUndefined();
  });
});
