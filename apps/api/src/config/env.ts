import { z } from "zod";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().url(),
    // Optional: when set, rate-limit counters live in Redis (shared by every API instance). When unset they live in
    // process memory, which is only correct for a single API instance (see SECURITY.md).
    REDIS_URL: z.string().url().optional(),
    SESSION_SECRET: z.string().min(32),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(1800),
    APP_URL: z.string().url(),
    // Recipient of operational notifications sent by the outbox worker (order created, order paid).
    OPS_EMAIL: z.string().email(),
    // No default here: production must say explicitly which mode it runs in (see superRefine below).
    INTEGRATIONS_MODE: z.enum(["fake", "sandbox", "live"]).optional(),
    PAYMENTS_PROVIDER: z.enum(["fake", "stripe", "wompi", "payu", "mercadopago"]).default("fake"),
    CARRIER_PROVIDER: z.enum(["fake", "oes"]).default("fake"),
    MESSAGING_PROVIDER: z.enum(["fake", "resend", "ses", "twilio"]).default("fake"),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === "production" && !e.INTEGRATIONS_MODE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["INTEGRATIONS_MODE"], message: "must be set explicitly in production (fake | sandbox | live); it never defaults to fake" });
    }
  })
  .transform((e) => ({ ...e, INTEGRATIONS_MODE: e.INTEGRATIONS_MODE ?? ("fake" as const) }));

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>) {
  return envSchema.safeParse(source);
}

const parsed = parseEnv(process.env);
if (!parsed.success) {
  // Fail fast: a misconfigured service must not start.
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env: Env = parsed.data;
export const APP_VERSION = process.env.APP_VERSION ?? "dev";
