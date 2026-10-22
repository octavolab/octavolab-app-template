import { prisma } from "@octavolab/db";
import { APP_VERSION, env } from "../config/env.js";

/**
 * Operational alerts evaluated by the worker every 60 s (SECURITY.md "accepted open items": alerting on `mfa_failed`
 * and `outbox_dead_letter`). Counts come from the database, not from logs, so they survive restarts and need no log
 * pipeline. Delivery goes straight to ALERT_WEBHOOK_URL (Slack incoming-webhook format, `{ "text": ... }`) with a 5 s
 * timeout and never through the outbox: an alert about dead letters must not depend on the outbox.
 *  - Cooldown: a rule fires at most once per 60 min per worker process, counted from its last SUCCESSFUL delivery; a failed
 *    POST is retried on the next tick. The cooldown lives in memory: a worker restart resets it, and with more than one
 *    node each node's worker alerts (the template runs one node).
 *  - Dead letters are counted since the last successful alert for that rule (or the last 15 min after a restart), so none
 *    that happen during the cooldown are lost; they are reported when it ends.
 * Without a webhook the alert is still logged as `alert_fired` (error level) so the Lightsail log shows it.
 */
export const WINDOW_MINUTES = 15;
export const COOLDOWN_MS = 60 * 60 * 1000;

export type AlertName = "mfa_failed_spike" | "outbox_dead_letter";
export type Alert = { alert: AlertName; count: number; windowMinutes: number; text: string };
type Db = { auditLog: Pick<typeof prisma.auditLog, "count">; outbox: Pick<typeof prisma.outbox, "count"> };
type Log = { warn(o: object, msg: string): void; error(o: object, msg: string): void };
export type AlertDeps = { db: Db; log: Log; now: () => Date; webhookUrl: string | undefined; mfaThreshold: number; fetch: typeof fetch; lastFired: Map<AlertName, number> };

export function defaultAlertDeps(log: Log): AlertDeps {
  return { db: prisma, log, now: () => new Date(), webhookUrl: env.ALERT_WEBHOOK_URL, mfaThreshold: env.MFA_FAILED_ALERT_THRESHOLD, fetch: globalThis.fetch, lastFired: new Map() };
}

/** Pure evaluation: which rules are over their threshold in the last window. */
export async function evaluate(deps: Pick<AlertDeps, "db" | "now" | "mfaThreshold"> & { lastFired?: Map<AlertName, number> }): Promise<Alert[]> {
  const since = new Date(deps.now().getTime() - WINDOW_MINUTES * 60_000);
  const lastDead = deps.lastFired?.get("outbox_dead_letter");
  const deadSince = lastDead !== undefined ? new Date(lastDead) : since;
  const [mfaFailed, deadLetters] = await Promise.all([
    deps.db.auditLog.count({ where: { action: "mfa_failed", createdAt: { gte: since } } }),
    deps.db.outbox.count({ where: { deadLetteredAt: { gt: deadSince } } }),
  ]);
  const alerts: Alert[] = [];
  if (mfaFailed >= deps.mfaThreshold) {
    alerts.push({ alert: "mfa_failed_spike", count: mfaFailed, windowMinutes: WINDOW_MINUTES, text: `${mfaFailed} failed second-factor attempts in the last ${WINDOW_MINUTES} min (threshold ${deps.mfaThreshold}). Check the audit log for mfa_failed.` });
  }
  if (deadLetters > 0) {
    alerts.push({ alert: "outbox_dead_letter", count: deadLetters, windowMinutes: WINDOW_MINUTES, text: `${deadLetters} outbox event(s) dead-lettered since ${deadSince.toISOString()}. Notifications were not delivered; see the runbook "Outbox dead letters".` });
  }
  return alerts;
}

/** Evaluates, applies the cooldown and delivers. Returns the alerts delivered (or logged when no webhook is set). Never throws. */
export async function checkAlerts(deps: AlertDeps): Promise<Alert[]> {
  let alerts: Alert[];
  try {
    alerts = await evaluate(deps);
  } catch (e) {
    deps.log.error({ event: "alert_check_error", error: String(e) }, "alert evaluation failed");
    return [];
  }
  const nowMs = deps.now().getTime();
  const fired: Alert[] = [];
  for (const a of alerts) {
    const last = deps.lastFired.get(a.alert);
    if (last !== undefined && nowMs - last < COOLDOWN_MS) continue;
    deps.log.error({ event: "alert_fired", alert: a.alert, count: a.count, windowMinutes: a.windowMinutes }, a.text);
    if (!deps.webhookUrl) { deps.lastFired.set(a.alert, nowMs); fired.push(a); continue; }
    try {
      const res = await deps.fetch(deps.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...a, text: `[OctavoLab ${APP_VERSION}] ${a.text}`, version: APP_VERSION }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) { deps.log.error({ event: "alert_delivery_failed", alert: a.alert, status: res.status }, "alert webhook answered an error"); continue; }
      deps.lastFired.set(a.alert, nowMs);
      fired.push(a);
    } catch (e) {
      deps.log.error({ event: "alert_delivery_failed", alert: a.alert, error: String(e) }, "alert webhook unreachable");
    }
  }
  return fired;
}
