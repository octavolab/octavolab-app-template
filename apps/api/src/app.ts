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
import { env } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { orderRoutes } from "./routes/orders.js";
import { authRoutes } from "./routes/auth.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { userRoutes } from "./routes/users.js";
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

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } } });
  await app.register(cors, { origin: [env.APP_URL], credentials: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  // Rate-limit counters: Redis when REDIS_URL is set (shared by every API instance); otherwise process memory, which is
  // only correct while the service runs ONE API instance (each instance would count separately). See SECURITY.md.
  const redis = env.REDIS_URL ? new Redis(env.REDIS_URL, { connectTimeout: 500, maxRetriesPerRequest: 1 }) : undefined;
  if (redis) app.addHook("onClose", async () => { await redis.quit(); });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute", nameSpace: "rl:", ...(redis ? { redis } : {}) });
  await app.register(swagger, { openapi: { info: { title: "API", version: "1.0.0" } }, transform: jsonSchemaTransform });

  app.addHook("onSend", async (req, reply) => { reply.header("x-request-id", req.id); });

  app.setErrorHandler((err: FastifyError & Partial<AppError>, req, reply) => {
    const requestId = req.id;
    if (err.validation || (err.statusCode && err.statusCode < 500)) {
      return reply.status(err.statusCode ?? 400).send({ code: err.code ?? "VALIDATION", message: err.message, requestId });
    }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ code: err.code, message: err.message, requestId });
    }
    req.log.error({ err, requestId }, "unhandled error");
    return reply.status(500).send({ code: "INTERNAL", message: "Unexpected error", requestId });
  });

  await app.register(healthRoutes, { prefix: "/api" });
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(orderRoutes, { prefix: "/api/v1" });
  await app.register(userRoutes, { prefix: "/api/v1" });
  await app.register(webhookRoutes, { prefix: "/api/v1" });
  await app.register(fastifyStatic, { root: path.resolve(process.cwd(), "apps/web/dist"), wildcard: false });
  app.setNotFoundHandler((req, reply) => req.url.startsWith("/api") ? reply.code(404).send({ code: "NOT_FOUND", message: "route not found", requestId: req.id }) : reply.sendFile("index.html"));
  return app;
}
