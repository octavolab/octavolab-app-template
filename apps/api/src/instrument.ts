import * as Sentry from "@sentry/node";
import { sentryOptions } from "./lib/sentry.js";

/**
 * Preloaded before the API or the worker (`node --import ./apps/api/dist/instrument.js ...`, see infra/Dockerfile and
 * infra/lightsail.json) so Sentry can instrument http, fastify and pg in ESM. A no-op without SENTRY_DSN.
 * Reads process.env directly: the env schema (config/env.ts) validates the same variables when the app starts.
 */
const service = /outbox\.worker\.(js|ts)$/.test(process.argv[1] ?? "") ? "worker" : "api";
const options = sentryOptions(process.env, service);
if (options) Sentry.init(options);
