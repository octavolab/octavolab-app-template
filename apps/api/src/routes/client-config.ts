import type { FastifyInstance } from "fastify";
import { APP_VERSION, env } from "../config/env.js";
import { tracesSampleRate } from "../lib/sentry.js";

/**
 * Public runtime configuration for the web app (the same image serves staging and production, so nothing
 * environment-specific is baked into the build). Only values that are public by design: the browser Sentry DSN is
 * meant to be embedded in client code. Never add a secret here.
 */
export function clientConfig() {
  const dsn = env.SENTRY_WEB_DSN ?? env.SENTRY_DSN;
  return {
    sentry: dsn ? { dsn, environment: env.APP_ENV, release: APP_VERSION, tracesSampleRate: tracesSampleRate({ APP_ENV: env.APP_ENV, SENTRY_TRACES_SAMPLE_RATE: env.SENTRY_TRACES_SAMPLE_RATE?.toString() }) } : null,
  };
}

/** Origin the browser SDK posts events to (added to the CSP connect-src), or undefined when the web DSN is unset. */
export function sentryIngestOrigin(): string | undefined {
  const dsn = env.SENTRY_WEB_DSN ?? env.SENTRY_DSN;
  return dsn ? new URL(dsn).origin : undefined;
}

export async function clientConfigRoutes(app: FastifyInstance) {
  app.get("/client-config", { schema: { tags: ["config"], summary: "Public runtime configuration for the web app (Sentry DSN, environment, release)" } }, async (_req, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return clientConfig();
  });
}
