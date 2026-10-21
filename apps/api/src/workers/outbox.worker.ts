import { prisma } from "@octavolab/db";
import { getMessaging } from "@octavolab/integrations";

/** Outbox dispatcher: at-least-once delivery, up to 8 attempts with exponential backoff (5 s × 2^attempts) and row claiming with FOR UPDATE SKIP LOCKED so two workers never send the same event. Run as the `worker` container. */
export async function dispatchOnce() {
  const events = await prisma.$queryRaw<{ id: string; type: string; payload: unknown; attempts: number }[]>`UPDATE "Outbox" SET "lockedUntil" = now() + interval '60 seconds' WHERE id IN (SELECT id FROM "Outbox" WHERE "deliveredAt" IS NULL AND attempts < 8 AND ("lockedUntil" IS NULL OR "lockedUntil" < now()) ORDER BY "createdAt" LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING id, type, payload, attempts`;
  for (const ev of events) {
    try {
      if (ev.type === "order.created") {
        await getMessaging().send({ to: "ops@example.com", template: "order_created", data: ev.payload as Record<string, unknown> });
      }
      await prisma.outbox.update({ where: { id: ev.id }, data: { deliveredAt: new Date(), attempts: { increment: 1 } } });
    } catch (err) {
      await prisma.outbox.update({ where: { id: ev.id }, data: { attempts: { increment: 1 }, lastError: String(err), lockedUntil: new Date(Date.now() + 5000 * 2 ** ev.attempts) } });
    }
  }
}

if (process.argv[1]?.endsWith("outbox.worker.js")) {
  const loop = async () => { await dispatchOnce().catch((e) => console.error(e)); setTimeout(loop, 2000); }; void loop();
}
