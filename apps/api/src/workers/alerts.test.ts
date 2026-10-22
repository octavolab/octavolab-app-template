import { describe, it, expect, vi, beforeAll } from "vitest";

Object.assign(process.env, { NODE_ENV: "test", DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "http://localhost:5173", OPS_EMAIL: "ops@test.invalid" });
vi.mock("@octavolab/db", () => ({ prisma: {}, Prisma: {} }));

let alerts: typeof import("./alerts.js");
beforeAll(async () => { alerts = await import("./alerts.js"); });

const NOW = new Date("2026-10-22T18:00:00Z");
function deps(counts: { mfa: number; dead: number }, opts: { webhook?: string; fetchImpl?: typeof fetch; threshold?: number } = {}) {
  const log = { warn: vi.fn(), error: vi.fn() };
  const auditCount = vi.fn(async () => counts.mfa);
  const outboxCount = vi.fn(async () => counts.dead);
  const fetchMock = vi.fn(opts.fetchImpl ?? (async () => new Response(null, { status: 200 })));
  let now = NOW;
  const d = {
    db: { auditLog: { count: auditCount }, outbox: { count: outboxCount } } as never,
    log, now: () => now, webhookUrl: opts.webhook, mfaThreshold: opts.threshold ?? 10, fetch: fetchMock as unknown as typeof fetch, lastFired: new Map(),
  };
  return { d, log, auditCount, outboxCount, fetchMock, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe("operational alerts", () => {
  it("queries only the last 15 minutes and stays quiet under the thresholds", async () => {
    const t = deps({ mfa: 9, dead: 0 });
    expect(await alerts.checkAlerts(t.d)).toEqual([]);
    const since = new Date(NOW.getTime() - 15 * 60_000);
    expect(t.auditCount).toHaveBeenCalledWith({ where: { action: "mfa_failed", createdAt: { gte: since } } });
    expect(t.outboxCount).toHaveBeenCalledWith({ where: { deadLetteredAt: { gt: since } } });
    expect(t.log.error).not.toHaveBeenCalled();
  });

  it("fires both rules, posts JSON to the webhook and respects the 60-minute cooldown", async () => {
    const t = deps({ mfa: 10, dead: 2 }, { webhook: "https://hooks.example.test/x" });
    const fired = await alerts.checkAlerts(t.d);
    expect(fired.map((a) => [a.alert, a.count])).toEqual([["mfa_failed_spike", 10], ["outbox_dead_letter", 2]]);
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = t.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.test/x");
    expect(JSON.parse(String(init.body))).toMatchObject({ alert: "mfa_failed_spike", count: 10, windowMinutes: 15 });
    expect(t.log.error).toHaveBeenCalledWith(expect.objectContaining({ event: "alert_fired", alert: "outbox_dead_letter" }), expect.any(String));

    t.advance(59 * 60_000);
    expect(await alerts.checkAlerts(t.d)).toEqual([]);
    t.advance(2 * 60_000);
    expect((await alerts.checkAlerts(t.d)).length).toBe(2);
  });

  it("logs the alert without a webhook, and a failing webhook or database never throws", async () => {
    const noHook = deps({ mfa: 0, dead: 1 });
    expect((await alerts.checkAlerts(noHook.d)).length).toBe(1);
    expect(noHook.fetchMock).not.toHaveBeenCalled();

    const down = deps({ mfa: 0, dead: 1 }, { webhook: "https://hooks.example.test/x", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    expect((await alerts.checkAlerts(down.d)).length).toBe(0); // not delivered: retried on the next tick
    expect(down.log.error).toHaveBeenCalledWith(expect.objectContaining({ event: "alert_delivery_failed" }), expect.any(String));

    const bad = deps({ mfa: 0, dead: 1 }, { webhook: "https://hooks.example.test/x", fetchImpl: async () => new Response(null, { status: 500 }) });
    await alerts.checkAlerts(bad.d);
    expect(bad.log.error).toHaveBeenCalledWith(expect.objectContaining({ event: "alert_delivery_failed", status: 500 }), expect.any(String));

    const dbDown = deps({ mfa: 0, dead: 0 });
    (dbDown.d.db as unknown as { outbox: { count: () => Promise<number> } }).outbox.count = async () => { throw new Error("db down"); };
    expect(await alerts.checkAlerts(dbDown.d)).toEqual([]);
    expect(dbDown.log.error).toHaveBeenCalledWith(expect.objectContaining({ event: "alert_check_error" }), expect.any(String));
  });

  it("uses the configured mfa threshold", async () => {
    const t = deps({ mfa: 3, dead: 0 }, { threshold: 3 });
    expect((await alerts.checkAlerts(t.d)).map((a) => a.alert)).toEqual(["mfa_failed_spike"]);
  });
  it("default deps read the environment and start with no cooldown history", () => {
    const d = alerts.defaultAlertDeps({ warn: vi.fn(), error: vi.fn() });
    expect([d.webhookUrl, d.mfaThreshold, d.lastFired.size]).toEqual([undefined, 10, 0]);
  });
  it("a failed delivery does not start the cooldown: the alert is retried on the next tick", async () => {
    let fail = true;
    const t = deps({ mfa: 0, dead: 1 }, { webhook: "https://hooks.example.test/x", fetchImpl: async () => (fail ? new Response(null, { status: 503 }) : new Response(null, { status: 200 })) });
    expect(await alerts.checkAlerts(t.d)).toEqual([]);
    expect(t.d.lastFired.size).toBe(0);
    fail = false;
    t.advance(60_000);
    expect((await alerts.checkAlerts(t.d)).map((a) => a.alert)).toEqual(["outbox_dead_letter"]);
  });

  it("after the cooldown, dead letters are counted since the last delivered alert, so none are lost", async () => {
    const t = deps({ mfa: 0, dead: 1 }, { webhook: "https://hooks.example.test/x" });
    await alerts.checkAlerts(t.d);
    t.advance(61 * 60_000);
    await alerts.checkAlerts(t.d);
    expect(t.outboxCount).toHaveBeenLastCalledWith({ where: { deadLetteredAt: { gt: NOW } } });
  });
});
