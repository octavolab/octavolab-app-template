import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
// The side-effect-free subpath: the package index resolves the mode at import and would throw before this schema can
// report every invalid variable at once.
import { normalizeIntegrationsMode, INTEGRATION_MODES } from "@octavolab/integrations/mode";
import { parseMasterKey } from "../lib/secret-box.js";
import { weakSessionSecretReason, weakMasterKeyReason, weakDatabaseUrlReason } from "../lib/secret-strength.js";

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
    // fake | test | live, case-insensitive (the old name "sandbox" is accepted as "test"). No default here: production must
    // say explicitly which mode it runs in (see superRefine below). Shared with the integrations package (mode.ts).
    INTEGRATIONS_MODE: z.string().optional()
      .transform((v, ctx) => {
        if (v === undefined || v.trim() === "") return undefined;
        const mode = normalizeIntegrationsMode(v);
        if (!mode) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be one of ${INTEGRATION_MODES.join(" | ")} (case-insensitive)` }); return z.NEVER; }
        return mode;
      }),
    PAYMENTS_PROVIDER: z.enum(["fake", "stripe", "wompi", "payu", "mercadopago"]).default("fake"),
    CARRIER_PROVIDER: z.enum(["fake", "oes"]).default("fake"),
    MESSAGING_PROVIDER: z.enum(["fake", "resend", "ses", "twilio"]).default("fake"),
    // Stripe (PAYMENTS_PROVIDER=stripe): test keys in INTEGRATIONS_MODE=test, live keys in live (checked in superRefine).
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // Resend (MESSAGING_PROVIDER=resend): required only when the provider is resend AND the mode is test or live.
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
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (e.NODE_ENV === "production" && !e.INTEGRATIONS_MODE) {
      issue("INTEGRATIONS_MODE", "must be set explicitly in production (fake | test | live); it never defaults to fake");
    }
    for (const [path, message] of integrationKeyIssues(e)) issue(path, message);
    // Production secrets must be real (docs/secrets.md): a weak or placeholder secret stops the process at boot.
    // Messages describe the rule only; no check ever echoes the value.
    if (e.NODE_ENV === "production") {
      const session = weakSessionSecretReason(e.SESSION_SECRET);
      if (session) issue("SESSION_SECRET", session);
      const db = weakDatabaseUrlReason(e.DATABASE_URL);
      if (db) issue("DATABASE_URL", db);
      if (e.TOTP_ENC_KEY && isMasterKey(e.TOTP_ENC_KEY)) {
        const totp = weakMasterKeyReason(parseMasterKey(e.TOTP_ENC_KEY));
        if (totp) issue("TOTP_ENC_KEY", totp);
      }
    }
  })
  .transform((e) => ({ ...e, INTEGRATIONS_MODE: e.INTEGRATIONS_MODE ?? ("fake" as const) }));

export type Env = z.infer<typeof envSchema>;

/**
 * Keys each integrations mode requires (fail fast at boot, never at the first request):
 * - fake: none (in-process adapters).
 * - test: PAYMENTS_PROVIDER=stripe with a TEST secret key (sk_test_/rk_test_) and STRIPE_WEBHOOK_SECRET (whsec_);
 *         MESSAGING_PROVIDER=resend with RESEND_API_KEY and MESSAGING_FROM (Resend delivers only to its test inbox).
 * - live: the same, with a LIVE Stripe key (sk_live_/rk_live_). Live keys are loaded by Jaime only (CLAUDE.md, N07).
 * Carrier quotes have no real adapter yet and nothing calls them at runtime; they stay fake in every mode.
 */
export function integrationKeyIssues(e: { INTEGRATIONS_MODE?: string | undefined; PAYMENTS_PROVIDER: string; MESSAGING_PROVIDER: string; STRIPE_SECRET_KEY?: string | undefined; STRIPE_WEBHOOK_SECRET?: string | undefined; RESEND_API_KEY?: string | undefined; MESSAGING_FROM?: string | undefined }): [string, string][] {
  const mode = e.INTEGRATIONS_MODE;
  if (mode !== "test" && mode !== "live") return [];
  const out: [string, string][] = [];
  const kind = mode === "live" ? "live" : "test";
  if (e.PAYMENTS_PROVIDER !== "stripe") out.push(["PAYMENTS_PROVIDER", `must be stripe when INTEGRATIONS_MODE=${mode} (the only real payments adapter)`]);
  else {
    if (!e.STRIPE_SECRET_KEY) out.push(["STRIPE_SECRET_KEY", `required when INTEGRATIONS_MODE=${mode}`]);
    else if (!new RegExp(`^(sk|rk)_${kind}_[A-Za-z0-9]+$`).test(e.STRIPE_SECRET_KEY)) out.push(["STRIPE_SECRET_KEY", `must be a Stripe ${kind} key (sk_${kind}_ or rk_${kind}_) when INTEGRATIONS_MODE=${mode}`]);
    if (!e.STRIPE_WEBHOOK_SECRET) out.push(["STRIPE_WEBHOOK_SECRET", `required when INTEGRATIONS_MODE=${mode}`]);
    else if (!/^whsec_[A-Za-z0-9]+$/.test(e.STRIPE_WEBHOOK_SECRET)) out.push(["STRIPE_WEBHOOK_SECRET", "must be a Stripe webhook signing secret (whsec_...)"]);
  }
  if (e.MESSAGING_PROVIDER !== "resend") out.push(["MESSAGING_PROVIDER", `must be resend when INTEGRATIONS_MODE=${mode} (the only real messaging adapter)`]);
  else for (const k of ["RESEND_API_KEY", "MESSAGING_FROM"] as const) if (!e[k]) out.push([k, `required when INTEGRATIONS_MODE=${mode}`]);
  return out;
}

/** The env-var owner bootstrap was removed (use `create-owner`, docs/runbook.md); its variables must never come back. */
const FORBIDDEN_PREFIX = "BOOTSTRAP_";

export function parseEnv(source: Record<string, string | undefined>) {
  // Backwards-compatible alias (until v1.0): REQUIRE_OWNER_2FA was renamed when admins were added; the new name wins.
  const src = { ...source };
  if (src.REQUIRE_PRIVILEGED_2FA === undefined && src.REQUIRE_OWNER_2FA !== undefined) src.REQUIRE_PRIVILEGED_2FA = src.REQUIRE_OWNER_2FA;
  const forbidden = Object.keys(src).filter((k) => k.startsWith(FORBIDDEN_PREFIX) && src[k] !== undefined).sort();
  return envSchema.superRefine((e, ctx) => {
    if (e.NODE_ENV !== "production") return;
    for (const k of forbidden) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: "is not allowed: create the owner with the create-owner CLI and remove this variable (it would keep a password in the deployment history)" });
    }
  }).safeParse(src);
}

const parsed = parseEnv(process.env);
if (!parsed.success) {
  // Fail fast: a misconfigured service must not start.
  // Field names and messages only: zod messages never contain the submitted values, so no secret reaches the log.
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env: Env = parsed.data;

/**
 * The deployed git commit, baked into the image at build time (infra/Dockerfile writes /app/VERSION from the GIT_SHA
 * build argument that infra/deploy.sh passes). Never read from the environment: an env var can be hand-edited or carried
 * over stale between Lightsail deployments, which is how /api/health and APP_VERSION disagreed on staging.
 */
export function readBuildVersion(file = path.resolve(process.cwd(), "VERSION")): string {
  try {
    const v = readFileSync(file, "utf8").trim();
    return /^[0-9a-f]{7,40}$/.test(v) ? v : "dev";
  } catch {
    return "dev";
  }
}
export const APP_VERSION = readBuildVersion();
