import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(1800),
  APP_URL: z.string().url(),
  INTEGRATIONS_MODE: z.enum(["fake", "sandbox", "live"]).default("fake"),
  PAYMENTS_PROVIDER: z.enum(["fake", "stripe", "wompi", "payu", "mercadopago"]).default("fake"),
  CARRIER_PROVIDER: z.enum(["fake", "oes"]).default("fake"),
  MESSAGING_PROVIDER: z.enum(["fake", "resend", "ses", "twilio"]).default("fake"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast: a misconfigured service must not start.
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
export const APP_VERSION = process.env.APP_VERSION ?? "dev";
