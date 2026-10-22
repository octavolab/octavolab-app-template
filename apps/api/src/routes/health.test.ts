import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { Redis } from "ioredis";

const queryRaw = vi.fn();
const ping = vi.fn();
vi.mock("@octavolab/db", () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));
vi.mock("@octavolab/integrations", () => ({ getPayments: () => ({ ping }) }));
const MODES = { payments: "sandbox", messaging: "sandbox", carrier: "fake", storage: "fake" };
vi.mock("../config/env.js", () => ({ APP_VERSION: "test", env: { INTEGRATIONS_MODE: "fake", MODES } }));
const { healthRoutes, probePayments, paymentsHealth, resetPaymentsProbe, PAYMENTS_PROBE_TTL_MS, PAYMENTS_PROBE_WAIT_MS } = await import("./health.js");

async function build(redis?: { ping: () => Promise<string> }) {
  const app = Fastify();
  if (redis) app.decorate("redis", redis as unknown as Redis);
  await app.register(healthRoutes);
  return app;
}
const log = { warn: vi.fn() };

describe("health", () => {
  beforeEach(() => { queryRaw.mockReset(); queryRaw.mockResolvedValue([{ 1: 1 }]); ping.mockReset(); ping.mockResolvedValue(undefined); resetPaymentsProbe(); log.warn.mockReset(); });

  it("reports ok for the database, Redis and payments, the version and every integration mode", async () => {
    const r = await (await build({ ping: async () => "PONG" })).inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, version: "test", mode: "fake", modes: MODES, deps: { db: "ok", redis: "ok", payments: "ok" } });
  });

  it("reports Redis down (unexpected reply or error) without failing the probe", async () => {
    const odd = await (await build({ ping: async () => "LOADING" })).inject({ method: "GET", url: "/health" });
    expect([odd.statusCode, odd.json().deps.redis]).toEqual([200, "down"]);
    const err = await (await build({ ping: async () => { throw new Error("ECONNREFUSED"); } })).inject({ method: "GET", url: "/health" });
    expect([err.statusCode, err.json().deps.redis]).toEqual([200, "down"]);
  });

  it("answers 503 when the database is down", async () => {
    queryRaw.mockRejectedValue(new Error("connection refused"));
    const r = await (await build()).inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ ok: false, deps: { db: "down", redis: "not_configured" } });
  });

  it("reports payments degraded without failing the probe", async () => {
    ping.mockRejectedValue(new Error("stripe balance 401 error"));
    const r = await (await build()).inject({ method: "GET", url: "/health" });
    expect([r.statusCode, r.json().ok, r.json().deps.payments]).toEqual([200, true, "degraded"]);
  });

  it("caches the payments probe for 60 s and shares an in-flight call", async () => {
    expect(PAYMENTS_PROBE_TTL_MS).toBe(60_000);
    const [a, b] = await Promise.all([probePayments(log, 0), probePayments(log, 10)]);
    expect([a, b, ping.mock.calls.length]).toEqual(["ok", "ok", 1]);
    ping.mockRejectedValue(new Error("down"));
    expect(await probePayments(log, 59_999)).toBe("ok");
    expect(await probePayments(log, 60_000)).toBe("degraded");
    expect(ping.mock.calls.length).toBe(2);
    expect(log.warn).toHaveBeenCalledWith({ event: "payments_probe_failed", error: "down" }, "payments health probe failed");
    ping.mockRejectedValue("not an error");
    expect(await probePayments(log, 200_000)).toBe("degraded");
    expect(log.warn).toHaveBeenLastCalledWith({ event: "payments_probe_failed", error: "unknown" }, "payments health probe failed");
  });

  it("never waits more than 1 s for the provider: a slow probe reads degraded while it finishes in the background", async () => {
    expect(PAYMENTS_PROBE_WAIT_MS).toBe(1000);
    let finish: () => void = () => {};
    ping.mockReturnValue(new Promise<void>((r) => { finish = r; }));
    expect(await paymentsHealth(log, 5)).toBe("degraded");
    finish();
    expect(await paymentsHealth(log, 5)).toBe("ok"); // the same cached probe has now completed
    expect(ping.mock.calls.length).toBe(1);
  });
});
