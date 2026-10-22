import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { Redis } from "ioredis";

const queryRaw = vi.fn();
vi.mock("@octavolab/db", () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));
vi.mock("../config/env.js", () => ({ APP_VERSION: "test", env: { INTEGRATIONS_MODE: "fake" } }));
const { healthRoutes } = await import("./health.js");

async function build(redis?: { ping: () => Promise<string> }) {
  const app = Fastify();
  if (redis) app.decorate("redis", redis as unknown as Redis);
  await app.register(healthRoutes);
  return app;
}

describe("health", () => {
  beforeEach(() => { queryRaw.mockReset(); queryRaw.mockResolvedValue([{ 1: 1 }]); });

  it("reports ok for the database and Redis", async () => {
    const r = await (await build({ ping: async () => "PONG" })).inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json().deps).toEqual({ db: "ok", redis: "ok" });
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
});
