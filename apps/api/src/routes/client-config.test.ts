import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const env: Record<string, unknown> = {};
vi.mock("../config/env.js", () => ({ APP_VERSION: "v0.8.0", env }));
const { clientConfigRoutes, clientConfig, sentryIngestOrigin } = await import("./client-config.js");

describe("client config", () => {
  beforeEach(() => { for (const k of Object.keys(env)) delete env[k]; env.APP_ENV = "staging"; });

  it("returns sentry: null and no ingest origin when no DSN is set", async () => {
    const app = Fastify();
    await app.register(clientConfigRoutes);
    const r = await app.inject({ method: "GET", url: "/client-config" });
    expect([r.statusCode, r.json(), r.headers["cache-control"]]).toEqual([200, { sentry: null }, "public, max-age=300"]);
    expect(sentryIngestOrigin()).toBeUndefined();
  });

  it("exposes only the public browser DSN, environment, release and sample rate", () => {
    env.SENTRY_DSN = "https://backend@o1.ingest.us.sentry.io/1";
    expect(clientConfig()).toEqual({ sentry: { dsn: "https://backend@o1.ingest.us.sentry.io/1", environment: "staging", release: "v0.8.0", tracesSampleRate: 0.1 } });
    env.SENTRY_WEB_DSN = "https://web@o2.ingest.us.sentry.io/2";
    env.SENTRY_TRACES_SAMPLE_RATE = 0.2;
    expect(clientConfig().sentry).toMatchObject({ dsn: "https://web@o2.ingest.us.sentry.io/2", tracesSampleRate: 0.2 });
    expect(sentryIngestOrigin()).toBe("https://o2.ingest.us.sentry.io");
  });
});
