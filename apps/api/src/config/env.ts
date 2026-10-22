import { z } from "zod";
import { validateIntegrationEnv, resolveModes, messagingFrom, type IntegrationMode } from "@octavolab/integrations/config";
import { parseMasterKey } from "../lib/secret-box.js";

const isMasterKey = (v: string) => { try { parseMasterKey(v); return true; } catch { return false; } };

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().url(),
    // Optional: when set, rate-limit counters live in Redis (shared by every API instance). When unset they live in
    // process memory, which is only correct for a single API instance (see SECURITY.md).
    REDIS_URL: z.string().url().optional(),
    // Global requests per minute per client IP (the login route has its own, stricter limit).
    RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(100_000).default(100),
    SESSION_SECRET: z.string().min(32),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(1800),
    APP_URL: z.string().url(),
    // Recipient of operational notifications sent by the outbox worker (order created, order paid).
    OPS_EMAIL: z.string().email(),
    // Deployment the process belongs to. deploy.sh sets it (staging | production); it names the Sentry environment, enables
    // the staging defaults (MESSAGING_FROM) and is the only place ALLOW_LIVE is accepted (production).
    APP_ENV: z.enum(["local", "test", "staging", "production"]).optional(),
    // Integration modes (ADR 0005). INTEGRATIONS_MODE is the default for the four per-integration modes; in production each
    // must resolve explicitly. The cross-field rules (providers, secrets per mode, ALLOW_LIVE) live in
    // @octavolab/integrations/config and run in superRefine below, so the API and the worker fail at boot, never at the first request.
    INTEGRATIONS_MODE: z.enum(["fake", "sandbox", "live"]).optional(),
    PAYMENTS_MODE: z.enum(["fake", "sandbox", "live"]).optional(),
    MESSAGING_MODE: z.enum(["fake", "sandbox", "live"]).optional(),
    CARRIER_MODE: z.enum(["fake", "sandbox", "live"]).optional(),
    STORAGE_MODE: z.enum(["fake", "sandbox", "live"]).optional(),
    // "true" only in production after Jaime's approval (N07); required for any integration in live mode.
    ALLOW_LIVE: z.enum(["true", "false"]).optional(),
    PAYMENTS_PROVIDER: z.enum(["fake", "stripe", "wompi", "payu", "mercadopago"]).default("fake"),
    CARRIER_PROVIDER: z.enum(["fake", "oes"]).default("fake"),
    MESSAGING_PROVIDER: z.enum(["fake", "resend", "ses", "twilio"]).default("fake"),
    STORAGE_PROVIDER: z.enum(["fake", "s3"]).default("fake"),
    // Stripe: test key (sk_test_/rk_test_) in sandbox, live key in live; checked against the mode in superRefine.
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // Resend (MESSAGING_PROVIDER=resend): required only when the provider is resend AND the mode is sandbox or live.
    RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_]+$/, "must be a Resend API key (re_...)").optional(),
    // Sender: "noreply@domain" or "Name <noreply@domain>"; the domain must be verified in Resend. Defaults on APP_ENV=staging.
    MESSAGING_FROM: z.string().max(320).regex(/^(?:[^<>\r\n]{1,100} <[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/, "must be an email or 'Name <email>'").optional(),
    // Sandbox only: comma-separated addresses that receive real test emails instead of delivered@resend.dev.
    MESSAGING_ALLOW_LIST: z.string().max(2000).optional(),
    // OES carrier (CARRIER_PROVIDER=oes): base URL per environment, key, and the quote path from the OES spec.
    OES_API_URL: z.string().optional(),
    OES_API_KEY: z.string().optional(),
    OES_QUOTE_PATH: z.string().optional(),
    // Lightsail bucket (STORAGE_PROVIDER=s3): bucket access key scoped to one bucket (not an IAM user).
    S3_ENDPOINT: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/, "must be an AWS region like eu-west-2").default("eu-west-2"),
    // Sentry: disabled unless SENTRY_DSN is set. SENTRY_WEB_DSN (public, browser project) defaults to SENTRY_DSN.
    SENTRY_DSN: z.string().url().optional(),
    SENTRY_WEB_DSN: z.string().url().optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
    // TOTP 2FA: master key for encrypting TOTP secrets at rest (AES-256-GCM) and keying recovery-code hashes.
    // 32 random bytes in base64: `openssl rand -base64 32`. Without it, 2FA endpoints answer 503 and accounts with 2FA
    // enabled cannot sign in (fail closed). Rotating it invalidates every enrolled secret (users re-enroll).
    TOTP_ENC_KEY: z.string().refine(isMasterKey, "must be 32 random bytes in base64 (openssl rand -base64 32)").optional(),
    // "true": an owner or admin without 2FA can sign in but every route except enrollment answers 403
    // MFA_ENROLLMENT_REQUIRED, and owners and admins cannot disable 2FA. Old name REQUIRE_OWNER_2FA is accepted (see parseEnv). Set to "true" in infra/lightsail.json for staging and production.
    REQUIRE_PRIVILEGED_2FA: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    // Issuer shown in authenticator apps (no colon: it is part of the otpauth label).
    TOTP_ISSUER: z.string().min(1).max(64).regex(/^[^:]+$/, "must not contain ':'").default("OctavoLab"),
  })
  .superRefine((e, ctx) => {
    if (e.REQUIRE_PRIVILEGED_2FA && !e.TOTP_ENC_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["TOTP_ENC_KEY"], message: "required when REQUIRE_PRIVILEGED_2FA=true" });
    }
    if (e.NODE_ENV === "production" && !e.APP_ENV) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["APP_ENV"], message: "must be set in production (staging | production); infra/deploy.sh sets it" });
    }
    // Messages name the variable and the rule, never the submitted value.
    for (const issue of validateIntegrationEnv(stringEnv(e))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
  })
  .transform((e) => {
    const modes = resolveModes(stringEnv(e)); // cannot throw: superRefine rejected every unresolved mode
    return {
      ...e,
      APP_ENV: e.APP_ENV ?? (e.NODE_ENV === "test" ? "test" as const : "local" as const),
      INTEGRATIONS_MODE: e.INTEGRATIONS_MODE ?? ("fake" as const),
      MODES: modes as Readonly<Record<keyof typeof modes, IntegrationMode>>,
      MESSAGING_FROM: messagingFrom(stringEnv(e)),
    };
  });

/** The parsed object as a string map, the shape the integration rules read (they also run on raw process.env). */
function stringEnv(e: Record<string, unknown>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v === undefined ? undefined : String(v)]));
}

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>) {
  // Backwards-compatible alias (until v1.0): REQUIRE_OWNER_2FA was renamed when admins were added; the new name wins.
  const src = { ...source };
  if (src.REQUIRE_PRIVILEGED_2FA === undefined && src.REQUIRE_OWNER_2FA !== undefined) src.REQUIRE_PRIVILEGED_2FA = src.REQUIRE_OWNER_2FA;
  return envSchema.safeParse(src);
}

const parsed = parseEnv(process.env);
if (!parsed.success) {
  // Fail fast: a misconfigured service must not start.
  // Field names and messages only: zod messages never contain the submitted values, so no secret reaches the log.
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env: Env = parsed.data;
export const APP_VERSION = process.env.APP_VERSION ?? "dev";
