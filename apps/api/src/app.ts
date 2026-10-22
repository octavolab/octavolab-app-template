import Fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import * as Sentry from "@sentry/node";
import { PaymentError, CarrierError, StorageError } from "@octavolab/integrations";
import { env } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { orderRoutes } from "./routes/orders.js";
import { authRoutes } from "./routes/auth.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { userRoutes } from "./routes/users.js";
import { meRoutes } from "./routes/me.js";
import { productRoutes } from "./routes/products.js";
import { clientConfigRoutes, sentryIngestOrigin } from "./routes/client-config.js";
import { AppError } from "./lib/errors.js";

/** A client-sent X-Request-Id is reused only if it is short and safe to log; anything else gets a fresh UUID. */
export const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/;
export function requestIdFrom(header: string | string[] | undefined): string {
  return typeof header === "string" && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

export async function buildApp(opts: { logStream?: { write(line: string): void } } = {}) {
  const redact = ["req.headers.authorization", "req.headers.cookie", "req.body.password"];
  const app = Fastify({
    // logStream lets tests capture structured logs (security events); production logs to stdout.
    logger: opts.logStream ? { level: "info", redact, stream: opts.logStream } : { level: env.NODE_ENV === "test" ? "silent" : "info", redact },
    genReqId: (req) => requestIdFrom(req.headers["x-request-id"]),
    trustProxy: (_addr: string, hop: number) => hop < 1, // trust only the Lightsail public endpoint (one hop; confirm on the first deploy): `true` trusts a client-sent X-Forwarded-For and defeats the rate limits
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Stripe Elements (checkout) needs its script, its iframes and its API; nothing else leaves 'self'. connect-src also
  // allows the Sentry ingest origin when the browser SDK is enabled (SENTRY_WEB_DSN or SENTRY_DSN).
  const ingest = sentryIngestOrigin();
  await app.register(helmet, { contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], frameAncestors: ["'none'"],
    scriptSrc: ["'self'", "https://js.stripe.com"],
    frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
    connectSrc: ["'self'", "https://api.stripe.com", ...(ingest ? [ingest] : [])],
  } } });
  await app.register(cors, { origin: [env.APP_URL], credentials: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  // Rate-limit counters: Redis when REDIS_URL is set (shared by every API instance); otherwise process memory, which is
  // only correct while the service runs ONE API instance (each instance would count separately). See SECURITY.md.
  const redis = env.REDIS_URL ? new Redis(env.REDIS_URL, { connectTimeout: 500, maxRetriesPerRequest: 1 }) : undefined;
  if (redis) app.addHook("onClose", async () => { await redis.quit(); });
  // skipOnError: if Redis is down, ordinary routes keep serving (fail open); the login route overrides this and fails closed.
  await app.register(rateLimit, { max: env.RATE_LIMIT_MAX, timeWindow: "1 minute", nameSpace: "rl:", skipOnError: true, ...(redis ? { redis } : {}) });
  app.decorate("redis", redis);
  await app.register(swagger, { openapi: { info: { title: "OctavoLab app template API", version: "1.0.0" }, components: { securitySchemes: { session: { type: "apiKey", in: "cookie", name: "sid" } } } }, transform: jsonSchemaTransform });

  app.addHook("onSend", async (req, reply) => { reply.header("x-request-id", req.id); });

  app.setErrorHandler((err: FastifyError & Partial<AppError>, req, reply) => {
    const requestId = req.id;
    if (err.validation || (err.statusCode && err.statusCode < 500)) {
      return reply.status(err.statusCode ?? 400).send({ code: err.code ?? "VALIDATION", message: err.message, requestId });
    }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ code: err.code, message: err.message, requestId });
    }
    // Provider failures (messages are already sanitized by the adapters): 503 when retrying later can help, else 502.
    if (err instanceof PaymentError || err instanceof CarrierError || err instanceof StorageError) {
      req.log.warn({ provider: err.name, code: err.code, status: err.status, requestId }, "provider error");
      Sentry.captureException(err, { tags: { provider_error: err.code } });
      return reply.status(err.retryable ? 503 : 502).send({ code: "PROVIDER_ERROR", message: "A provider could not complete the request; try again later", requestId });
    }
    Sentry.captureException(err, { tags: { request_id: requestId } }); // no-op when Sentry is not initialised
    req.log.error({ err, requestId }, "unhandled error");
    return reply.status(500).send({ code: "INTERNAL", message: "Unexpected error", requestId });
  });

  await app.register(healthRoutes, { prefix: "/api" });
  await app.register(clientConfigRoutes, { prefix: "/api" });
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(orderRoutes, { prefix: "/api/v1" });
  await app.register(userRoutes, { prefix: "/api/v1" });
  await app.register(meRoutes, { prefix: "/api/v1" });
  await app.register(productRoutes, { prefix: "/api/v1" });
  await app.register(webhookRoutes, { prefix: "/api/v1" });
  // OpenAPI 3 document generated from the zod route schemas; the committed copy is docs/openapi.json (kept in sync by a test).
  if (env.NODE_ENV !== "production") app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  await app.register(fastifyStatic, { root: path.resolve(process.cwd(), "apps/web/dist"), wildcard: false });
  app.setNotFoundHandler((req, reply) => req.url.startsWith("/api") ? reply.code(404).send({ code: "NOT_FOUND", message: "route not found", requestId: req.id }) : reply.sendFile("index.html"));
  return app;
}
