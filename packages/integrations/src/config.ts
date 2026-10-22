/**
 * Per-integration mode resolution and boot-time validation (ADR 0005).
 *
 * Every integration has its own mode (`PAYMENTS_MODE`, `MESSAGING_MODE`, `CARRIER_MODE`, `STORAGE_MODE`), each one
 * `fake | sandbox | live` and each defaulting to `INTEGRATIONS_MODE` (backward compatible: a deployment that only sets
 * `INTEGRATIONS_MODE` behaves exactly as before). Outside production an unresolved mode is `fake`; in production every
 * mode must resolve explicitly.
 *
 * `validateIntegrationEnv` is the single source of truth for "can this process start with these integrations": the API
 * env schema (apps/api/src/config/env.ts, used by the API and the worker) turns its issues into zod issues so the
 * process exits at boot, and the adapter factories in index.ts call it again so a misconfiguration can never surface at
 * the first request. Issue messages name the variable and never contain its value.
 */
export type IntegrationMode = "fake" | "sandbox" | "live";
export const INTEGRATION_MODES: readonly IntegrationMode[] = ["fake", "sandbox", "live"];
export const INTEGRATIONS = ["payments", "messaging", "carrier", "storage"] as const;
export type IntegrationName = (typeof INTEGRATIONS)[number];

export const MODE_VARS: Readonly<Record<IntegrationName, string>> = {
  payments: "PAYMENTS_MODE",
  messaging: "MESSAGING_MODE",
  carrier: "CARRIER_MODE",
  storage: "STORAGE_MODE",
};

/** Providers with a real adapter in this package. Anything else in a non-fake mode is a boot error. */
export const PROVIDERS: Readonly<Record<IntegrationName, { variable: string; implemented: readonly string[] }>> = {
  payments: { variable: "PAYMENTS_PROVIDER", implemented: ["stripe"] },
  messaging: { variable: "MESSAGING_PROVIDER", implemented: ["resend"] },
  carrier: { variable: "CARRIER_PROVIDER", implemented: ["oes"] },
  storage: { variable: "STORAGE_PROVIDER", implemented: ["s3"] },
};

/** Sender used on staging when MESSAGING_FROM is not set (domain verified in Resend, eu-west-1). */
export const STAGING_MESSAGING_FROM = "OctavoLab Staging <noreply@24hcargo.com>";
/** Lightsail buckets of this project live in eu-west-2. */
export const DEFAULT_S3_REGION = "eu-west-2";

export type EnvSource = Readonly<Record<string, string | undefined>>;
export type ConfigIssue = { path: string; message: string };

const isMode = (v: string | undefined): v is IntegrationMode => v !== undefined && (INTEGRATION_MODES as readonly string[]).includes(v);
const blank = (v: string | undefined) => v === undefined || v.trim() === "";
const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

/** Mode of one integration: its own variable, else INTEGRATIONS_MODE, else `fake` outside production, else undefined. */
export function resolveMode(env: EnvSource, name: IntegrationName): IntegrationMode | undefined {
  const own = env[MODE_VARS[name]];
  if (!blank(own)) return isMode(own) ? own : undefined;
  const global = env.INTEGRATIONS_MODE;
  if (!blank(global)) return isMode(global) ? global : undefined;
  return env.NODE_ENV === "production" ? undefined : "fake";
}

export type ResolvedModes = Record<IntegrationName, IntegrationMode>;

/** All four modes; throws (naming the variable) when one cannot be resolved. Use after validateIntegrationEnv passed. */
export function resolveModes(env: EnvSource): ResolvedModes {
  const out = {} as ResolvedModes;
  for (const name of INTEGRATIONS) {
    const mode = resolveMode(env, name);
    if (!mode) throw new Error(`${MODE_VARS[name]} (or INTEGRATIONS_MODE) must be set explicitly in production`);
    out[name] = mode;
  }
  return out;
}

/** MESSAGING_FROM with the staging default applied. */
export function messagingFrom(env: EnvSource): string | undefined {
  if (!blank(env.MESSAGING_FROM)) return env.MESSAGING_FROM;
  return env.APP_ENV === "staging" ? STAGING_MESSAGING_FROM : undefined;
}

/** MESSAGING_ALLOW_LIST as lower-case addresses (comma-separated, blanks ignored). */
export function messagingAllowList(env: EnvSource): string[] {
  return (env.MESSAGING_ALLOW_LIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** `sk_test_...` / `rk_test_...` in sandbox, `sk_live_...` / `rk_live_...` in live (restricted keys are preferred). */
export function stripeKeyMatchesMode(key: string, mode: "sandbox" | "live"): boolean {
  return new RegExp(`^(sk|rk)_${mode === "live" ? "live" : "test"}_[A-Za-z0-9]+$`).test(key);
}

const httpsUrl = (v: string) => { try { return new URL(v).protocol === "https:"; } catch { return false; } };

/**
 * Every problem that would stop the integrations from working with this environment. Empty means the process may start.
 * Rules (ADR 0005):
 * - each mode is `fake | sandbox | live`; in production each must resolve explicitly (own variable or INTEGRATIONS_MODE);
 * - `live` for any integration requires ALLOW_LIVE=true, and ALLOW_LIVE=true is only accepted with APP_ENV=production;
 * - a non-fake mode needs an implemented provider and that provider's secrets, in the format of that mode.
 */
export function validateIntegrationEnv(env: EnvSource): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const prod = env.NODE_ENV === "production";

  for (const v of ["INTEGRATIONS_MODE", ...Object.values(MODE_VARS)]) {
    if (!blank(env[v]) && !isMode(env[v])) add(v, "must be one of fake | sandbox | live");
  }
  const allowLive = env.ALLOW_LIVE === "true";
  if (!blank(env.ALLOW_LIVE) && env.ALLOW_LIVE !== "true" && env.ALLOW_LIVE !== "false") add("ALLOW_LIVE", "must be true or false");
  if (allowLive && env.APP_ENV !== "production") add("ALLOW_LIVE", "is only accepted with APP_ENV=production (set after Jaime's approval, N07)");

  const modes = {} as Partial<ResolvedModes>;
  for (const name of INTEGRATIONS) {
    const variable = MODE_VARS[name];
    const raw = env[variable];
    if (!blank(raw) && !isMode(raw)) continue; // already reported
    const mode = resolveMode(env, name);
    if (!mode) {
      if (prod) add(variable, `must be set explicitly in production (${variable} or INTEGRATIONS_MODE: fake | sandbox | live); it never defaults to fake`);
      continue;
    }
    modes[name] = mode;
    if (mode === "live" && !allowLive) add(variable, "live requires ALLOW_LIVE=true (production only, after Jaime's approval, N07)");
    if (mode === "fake") continue;
    const { variable: providerVar, implemented } = PROVIDERS[name];
    const provider = env[providerVar];
    if (blank(provider) || !implemented.includes(provider!)) {
      add(providerVar, `must be ${implemented.join(" | ")} when ${variable} is ${mode} (no other adapter is implemented)`);
    }
  }

  // Provider secrets, only for the integrations that will really call a provider.
  const p = modes.payments;
  if ((p === "sandbox" || p === "live") && env.PAYMENTS_PROVIDER === "stripe") {
    const key = env.STRIPE_SECRET_KEY;
    if (blank(key)) add("STRIPE_SECRET_KEY", `required when PAYMENTS_MODE is ${p}`);
    else if (!stripeKeyMatchesMode(key!, p)) add("STRIPE_SECRET_KEY", p === "live" ? "must be a live key (sk_live_ or rk_live_) when PAYMENTS_MODE=live" : "must be a test key (sk_test_ or rk_test_) when PAYMENTS_MODE=sandbox");
    if (blank(env.STRIPE_WEBHOOK_SECRET)) add("STRIPE_WEBHOOK_SECRET", `required when PAYMENTS_MODE is ${p}`);
    else if (!/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET!)) add("STRIPE_WEBHOOK_SECRET", "must be a Stripe webhook signing secret (whsec_...)");
  }

  const m = modes.messaging;
  if ((m === "sandbox" || m === "live") && env.MESSAGING_PROVIDER === "resend") {
    if (blank(env.RESEND_API_KEY)) add("RESEND_API_KEY", `required when MESSAGING_MODE is ${m}`);
    else if (!/^re_[A-Za-z0-9_]+$/.test(env.RESEND_API_KEY!)) add("RESEND_API_KEY", "must be a Resend API key (re_...)");
    if (!messagingFrom(env)) add("MESSAGING_FROM", `required when MESSAGING_MODE is ${m} (defaults only on APP_ENV=staging)`);
  }
  if (!blank(env.MESSAGING_ALLOW_LIST)) {
    if (messagingAllowList(env).some((a) => !EMAIL.test(a))) add("MESSAGING_ALLOW_LIST", "must be a comma-separated list of email addresses");
    if (m === "live") add("MESSAGING_ALLOW_LIST", "only applies to MESSAGING_MODE=sandbox; remove it in live");
  }

  const c = modes.carrier;
  if ((c === "sandbox" || c === "live") && env.CARRIER_PROVIDER === "oes") {
    for (const k of ["OES_API_URL", "OES_API_KEY", "OES_QUOTE_PATH"]) if (blank(env[k])) add(k, `required when CARRIER_MODE is ${c}`);
    if (!blank(env.OES_API_URL) && !httpsUrl(env.OES_API_URL!)) add("OES_API_URL", "must be an https URL");
    if (!blank(env.OES_QUOTE_PATH) && !/^\/[A-Za-z0-9/_.-]{1,200}$/.test(env.OES_QUOTE_PATH!)) add("OES_QUOTE_PATH", "must be a path starting with / (from the OES API spec)");
  }

  const s = modes.storage;
  if ((s === "sandbox" || s === "live") && env.STORAGE_PROVIDER === "s3") {
    for (const k of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) if (blank(env[k])) add(k, `required when STORAGE_MODE is ${s}`);
    if (!blank(env.S3_ENDPOINT) && !httpsUrl(env.S3_ENDPOINT!)) add("S3_ENDPOINT", "must be an https URL");
    if (!blank(env.S3_BUCKET) && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_BUCKET!)) add("S3_BUCKET", "must be a valid bucket name");
    if (!blank(env.S3_ACCESS_KEY) && !/^[A-Z0-9]{16,128}$/.test(env.S3_ACCESS_KEY!)) add("S3_ACCESS_KEY", "must be a bucket access key id (upper-case letters and digits)");
  }
  return issues;
}

/** Throws the first issue (variable name and rule only). Used by the factories as a second line of defence. */
export function assertIntegrationEnv(env: EnvSource): void {
  const [first] = validateIntegrationEnv(env);
  if (first) throw new Error(`invalid integration configuration: ${first.path} ${first.message}`);
}
