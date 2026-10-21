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
import { env } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { orderRoutes } from "./routes/orders.js";
import { authRoutes } from "./routes/auth.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { AppError } from "./lib/errors.js";

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.NODE_ENV === "test" ? "silent" : "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    trustProxy: true,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } } });
  await app.register(cors, { origin: [env.APP_URL], credentials: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(swagger, { openapi: { info: { title: "API", version: "1.0.0" } }, transform: jsonSchemaTransform });

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
  await app.register(webhookRoutes, { prefix: "/api/v1" });
  await app.register(fastifyStatic, { root: path.resolve(process.cwd(), "apps/web/dist"), wildcard: false });
  app.setNotFoundHandler((req, reply) => req.url.startsWith("/api") ? reply.code(404).send({ code: "NOT_FOUND", message: "route not found", requestId: req.id }) : reply.sendFile("index.html"));
  return app;
}
