/**
 * Browser error reporting. Enabled only when the API's public runtime config carries a Sentry DSN
 * (`GET /api/client-config`: SENTRY_WEB_DSN or SENTRY_DSN), so one image serves staging and production and local
 * development never loads the SDK. The SDK is imported lazily: without a DSN it is never downloaded. Default PII
 * collection is off in this SDK version; scrubEvent removes user and request details on top of that.
 */
type ClientConfig = { sentry: { dsn: string; environment: string; release: string; tracesSampleRate: number } | null };

const PATTERNS: [RegExp, string][] = [
  [/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g, "[stripe-key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];
export const scrub = (s: string) => PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
const stripQuery = (url: string) => url.split("?")[0]!;

type ScrubbableEvent = {
  user?: unknown;
  message?: string;
  request?: { url?: string; cookies?: unknown; headers?: unknown; data?: unknown; query_string?: unknown };
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
};

/** Removes the user, request body, cookies, headers and query strings; masks emails and tokens in messages. */
export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  delete event.user;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.url) event.request.url = stripQuery(event.request.url);
  }
  if (event.message) event.message = scrub(event.message);
  for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrub(ex.value);
  for (const b of event.breadcrumbs ?? []) {
    if (b.message) b.message = scrub(b.message);
    if (b.data && typeof b.data.url === "string") b.data.url = stripQuery(b.data.url);
  }
  return event;
}

export async function initSentry(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  let config: ClientConfig;
  try {
    const res = await fetchImpl("/api/client-config");
    if (!res.ok) return false;
    config = (await res.json()) as ClientConfig;
  } catch {
    return false; // reporting must never break the app
  }
  if (!config.sentry) return false;
  const Sentry = await import("@sentry/react");
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    release: config.sentry.release,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: config.sentry.tracesSampleRate,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  });
  return true;
}
