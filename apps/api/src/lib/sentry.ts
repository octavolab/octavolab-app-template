import type { Breadcrumb, ErrorEvent, NodeOptions } from "@sentry/node";

/**
 * Sentry configuration shared by the API and the worker (instrument.ts preloads it with `node --import`).
 * Enabled only when SENTRY_DSN is set; `environment` = APP_ENV (staging | production), `release` = APP_VERSION.
 * Default PII is off and every event passes through `scrubEvent`: cookies, auth headers, request bodies, user data and
 * anything that looks like a secret or an email address are removed before the event leaves the process.
 */
export type SentryEnv = Readonly<Record<string, string | undefined>>;

export function tracesSampleRate(env: SentryEnv): number {
  const explicit = env.SENTRY_TRACES_SAMPLE_RATE;
  if (explicit !== undefined && explicit !== "") {
    const n = Number(explicit);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return env.APP_ENV === "production" ? 0.05 : 0.1;
}

export function sentryOptions(env: SentryEnv, service: "api" | "worker"): NodeOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  return {
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENV ?? "local",
    release: env.APP_VERSION ?? "dev",
    serverName: service, // never the container hostname
    sendDefaultPii: false,
    tracesSampleRate: tracesSampleRate(env),
    initialScope: { tags: { service } },
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (b) => scrubBreadcrumb(b),
  };
}

// Values that must never reach Sentry. Order matters: specific token shapes before the generic ones.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g, "[stripe-key]"],
  [/\bwhsec_[A-Za-z0-9]+/g, "[webhook-secret]"],
  [/\bre_[A-Za-z0-9_]{6,}/g, "[resend-key]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[aws-key-id]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\b(postgres(?:ql)?|redis|rediss):\/\/[^\s@/]+@/gi, "$1://[redacted]@"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];
const SENSITIVE_KEY = /pass|secret|token|authorization|cookie|api[-_]?key|session|signature|idempotency|totp|recovery|card|iban|email/i;

export function scrubString(s: string): string {
  return SECRET_PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

/** Recursively scrubs strings and drops values under sensitive keys. Depth-limited; cycles cannot occur in events. */
export function scrubValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return scrubString(v);
  if (depth > 8 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrubValue(val, depth + 1);
  return out;
}

const stripQuery = (url: string) => url.split("?")[0]!;

export function scrubEvent<E extends ErrorEvent | Parameters<NonNullable<NodeOptions["beforeSendTransaction"]>>[0]>(event: E): E {
  delete event.user;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.url) event.request.url = stripQuery(event.request.url);
    if (event.request.headers) event.request.headers = scrubValue(event.request.headers) as Record<string, string>;
  }
  if (event.message) event.message = scrubString(event.message);
  for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrubString(ex.value);
  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as typeof event.contexts;
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  if (event.transaction) event.transaction = stripQuery(scrubString(event.transaction));
  return event;
}

export function scrubBreadcrumb(b: Breadcrumb): Breadcrumb {
  const out: Breadcrumb = { ...b };
  if (out.message) out.message = scrubString(out.message);
  if (out.data) {
    out.data = scrubValue(out.data) as Record<string, unknown>;
    if (typeof out.data.url === "string") out.data.url = stripQuery(out.data.url);
  }
  return out;
}
