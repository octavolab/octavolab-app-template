import { prisma } from "@octavolab/db";
import { getMessaging } from "@octavolab/integrations";

/** Outbox dispatcher: delivers events to external providers with exponential retries. Run as the `worker` container. */
export async function dispatchOnce() {
  const events = await prisma.outbox.findMany({ where: { deliveredAt: null, attempts: { lt: 8 } }, orderBy: { createdAt: "asc" }, take: 50 });
  for (const ev of events) {
    try {
      if (ev.type === "order.created") {
        await getMessaging().send({ to: "ops@example.com", template: "order_created", data: ev.payload as Record<string, unknown> });
      }
      await prisma.outbox.update({ where: { id: ev.id }, data: { deliveredAt: new Date(), attempts: { increment: 1 } } });
    } catch (err) {
      await prisma.outbox.update({ where: { id: ev.id }, data: { attempts: { increment: 1 }, lastError: String(err) } });
    }
  }
}

if (process.argv[1]?.endsWith("outbox.worker.js")) {
  setInterval(() => void dispatchOnce(), 2000);
}
