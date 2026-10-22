import { z } from "zod";
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
    // No default here: production must say explicitly which mode it runs in (see superRefine below).
    INTEGRATIONS_MODE: z.enum(["fake", "sandbox", "live"]).optional(),
    PAYMENTS_PROVIDER: z.enum(["fake", "stripe", "wompi", "payu", "mercadopago"]).default("fake"),
    CARRIER_PROVIDER: z.enum(["fake", "oes"]).default("fake"),
    MESSAGING_PROVIDER: z.enum(["fake", "resend", "ses", "twilio"]).default("fake"),
    // Resend (MESSAGING_PROVIDER=resend): required only when the provider is resend AND the mode is sandbox or live.
    RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_]+$/, "must be a Resend API key (re_...)").optional(),
    // Sender: "noreply@domain" or "Name <noreply@domain>"; the domain must be verified in Resend (live).
    MESSAGING_FROM: z.string().max(320).regex(/^(?:[^<>\r\n]{1,100} <[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/, "must be an email or 'Name <email>'").optional(),
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
    if (e.NODE_ENV === "production" && !e.INTEGRATIONS_MODE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["INTEGRATIONS_MODE"], message: "must be set explicitly in production (fake | sandbox | live); it never defaults to fake" });
    }
    const realMode = e.INTEGRATIONS_MODE === "sandbox" || e.INTEGRATIONS_MODE === "live";
    if (e.MESSAGING_PROVIDER === "resend" && realMode) {
      for (const k of ["RESEND_API_KEY", "MESSAGING_FROM"] as const) {
        if (!e[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: "required when MESSAGING_PROVIDER=resend and INTEGRATIONS_MODE is sandbox or live" });
      }
    }
  })
  .transform((e) => ({ ...e, INTEGRATIONS_MODE: e.INTEGRATIONS_MODE ?? ("fake" as const) }));

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
