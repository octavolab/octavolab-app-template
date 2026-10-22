import { prisma } from "@octavolab/db";
import { pino } from "pino";
import { getMessaging, type MessagingProvider } from "@octavolab/integrations";
import { env } from "../config/env.js";
import { checkAlerts, defaultAlertDeps } from "./alerts.js";

/**
 * Outbox dispatcher: at-least-once delivery. Rows are claimed with FOR UPDATE SKIP LOCKED plus a 60 s lease so two
 * workers never send the same event; failures back off exponentially (5 s x 2^attempts). Each event type has an
 * explicit handler; an unknown type is a failure (lastError set, never marked delivered). After MAX_ATTEMPTS the event
 * is dead-lettered (deadLetteredAt) and an `outbox_dead_letter` error line is logged for alerting. An error that says it
 * cannot succeed on retry (`retryable === false`, e.g. MessagingError for an invalid recipient) is dead-lettered at once.
 * Handlers receive the event id so providers can deduplicate retries (`outbox:<id>` as the provider idempotency key).
 * Runs as the `worker` container (infra/lightsail.json).
 */
export const MAX_ATTEMPTS = 8;

export type OutboxEvent = { id: string; type: string; payload: unknown; attempts: number };
export type HandlerDeps = { messaging: () => MessagingProvider; opsEmail: string };
export type Handler = (payload: Record<string, unknown>, deps: HandlerDeps, meta: { eventId: string }) => Promise<void>;
type Log = { info(o: object, msg: string): void; warn(o: object, msg: string): void; error(o: object, msg: string): void };

const notifyOps = (template: string): Handler => async (payload, d, meta) => {
  await d.messaging().send({ to: d.opsEmail, template, data: payload, idempotencyKey: `outbox:${meta.eventId}` });
};

/** True only when the error explicitly says a retry cannot help (MessagingError.retryable === false). */
const isPermanent = (err: unknown) => typeof err === "object" && err !== null && (err as { retryable?: unknown }).retryable === false;

export const handlers: Readonly<Record<string, Handler>> = {
  "order.created": notifyOps("order_created"),
  "order.paid": notifyOps("order_paid"),
};

type Db = Pick<typeof prisma, "$queryRaw" | "outbox">;
export type WorkerDeps = HandlerDeps & { db: Db; log: Log; handlers: Readonly<Record<string, Handler>>; now: () => Date };

export function defaultDeps(): WorkerDeps {
  return { db: prisma, messaging: getMessaging, opsEmail: env.OPS_EMAIL, log: pino({ name: "outbox-worker" }), handlers, now: () => new Date() };
}

/** Claims up to 50 pending events (not delivered, not dead-lettered, lease expired) for this worker. */
export function claimBatch(db: Pick<typeof prisma, "$queryRaw">) {
  return db.$queryRaw<OutboxEvent[]>`UPDATE "Outbox" SET "lockedUntil" = now() + interval '60 seconds' WHERE id IN (SELECT id FROM "Outbox" WHERE "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL AND attempts < ${MAX_ATTEMPTS} AND ("lockedUntil" IS NULL OR "lockedUntil" < now()) ORDER BY "createdAt" LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING id, type, payload, attempts`;
}

export async function dispatchOnce(deps: WorkerDeps = defaultDeps()) {
  const result = { delivered: 0, failed: 0, deadLettered: 0 };
  const events = await claimBatch(deps.db);
  for (const ev of events) {
    try {
      const handler = deps.handlers[ev.type];
      if (!handler) throw new Error(`no handler for outbox event type "${ev.type}"`);
      await handler((ev.payload ?? {}) as Record<string, unknown>, deps, { eventId: ev.id });
      await deps.db.outbox.update({ where: { id: ev.id }, data: { deliveredAt: deps.now(), attempts: { increment: 1 }, lastError: null } });
      result.delivered++;
    } catch (err) {
      const attempts = ev.attempts + 1;
      const lastError = String(err instanceof Error ? err.message : err).slice(0, 1000);
      const permanent = isPermanent(err);
      if (attempts >= MAX_ATTEMPTS || permanent) {
        await deps.db.outbox.update({ where: { id: ev.id }, data: { attempts: { increment: 1 }, lastError, deadLetteredAt: deps.now(), lockedUntil: null } });
        deps.log.error({ event: "outbox_dead_letter", metric: "outbox_dead_letter_total", outboxId: ev.id, type: ev.type, attempts, permanent, lastError }, "outbox event dead-lettered");
        result.deadLettered++;
      } else {
        await deps.db.outbox.update({ where: { id: ev.id }, data: { attempts: { increment: 1 }, lastError, lockedUntil: new Date(deps.now().getTime() + 5000 * 2 ** ev.attempts) } });
        deps.log.warn({ event: "outbox_retry", outboxId: ev.id, type: ev.type, attempts, lastError }, "outbox event failed; will retry");
        result.failed++;
      }
    }
  }
  return result;
}

if (/outbox\.worker\.(js|ts)$/.test(process.argv[1] ?? "")) {
  const deps = defaultDeps();
  const loop = async () => { await dispatchOnce(deps).catch((e) => deps.log.error({ event: "outbox_loop_error", error: String(e) }, "outbox loop error")); setTimeout(loop, 2000); };
  void loop();
  // Operational alerts (mfa_failed spike, dead letters): evaluated every 60 s in the same process (workers/alerts.ts).
  const alertDeps = defaultAlertDeps(deps.log);
  const alertLoop = async () => { await checkAlerts(alertDeps); setTimeout(alertLoop, 60_000); };
  void alertLoop();
}
