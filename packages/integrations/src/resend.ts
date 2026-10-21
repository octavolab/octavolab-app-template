import type { MessageInput, MessagingProvider } from "./contracts.js";
import { MessagingError } from "./contracts.js";
import { renderTemplate } from "./templates.js";

/**
 * Resend email adapter (https://resend.com/docs/api-reference/emails/send-email), HTTP API through fetch, no SDK.
 * Read the API reference on the day of integration (N02) and record it in docs/integrations/resend.md.
 *
 * - Requires RESEND_API_KEY and MESSAGING_FROM (the API env schema enforces both when MESSAGING_PROVIDER=resend and
 *   INTEGRATIONS_MODE is sandbox or live). The key is only ever placed in the Authorization header.
 * - One attempt per call with a timeout (default 10 s). Retries belong to the outbox worker (backoff, dead letter), so a
 *   slow provider never multiplies inside one claim lease. The outbox passes `outbox:<eventId>` as Idempotency-Key, so a
 *   retry after a timeout that actually succeeded is not delivered twice (Resend keeps keys for 24 hours).
 * - Errors become MessagingError with a sanitized message (`resend <status> <error name>`): never the key, the recipient
 *   or the provider's free text. `retryable=false` for requests that cannot succeed on retry.
 * - Sandbox mode never emails real people: every recipient is replaced by Resend's test inbox
 *   (delivered@resend.dev) unless it is already an @resend.dev address. Real recipients only in live mode (CLAUDE.md).
 */
export const RESEND_SANDBOX_RECIPIENT = "delivered@resend.dev";
const ENDPOINT = "https://api.resend.com/emails";
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export type ResendOptions = {
  apiKey?: string | undefined;
  from?: string | undefined;
  sandbox: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class ResendMessaging implements MessagingProvider {
  readonly name = "resend";
  private readonly apiKey: string;
  private readonly from: string;
  private readonly sandbox: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ResendOptions) {
    const apiKey = opts.apiKey ?? process.env.RESEND_API_KEY;
    const from = opts.from ?? process.env.MESSAGING_FROM;
    if (!apiKey) throw new Error("RESEND_API_KEY missing");
    if (!/^re_[A-Za-z0-9_]+$/.test(apiKey)) throw new Error("RESEND_API_KEY has an unexpected format"); // never echo the value
    if (!from) throw new Error("MESSAGING_FROM missing");
    this.apiKey = apiKey;
    this.from = from;
    this.sandbox = opts.sandbox;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    // Resolved at call time by default so tests (and runtime instrumentation) can replace globalThis.fetch.
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  }

  async send(input: MessageInput): Promise<{ providerRef: string }> {
    if (!EMAIL.test(input.to) || input.to.length > 254) throw new MessagingError("resend invalid recipient", "invalid_recipient", false);
    const rendered = renderTemplate(input.template, input.data);
    const to = this.sandbox && !input.to.toLowerCase().endsWith("@resend.dev") ? RESEND_SANDBOX_RECIPIENT : input.to;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "User-Agent": "octavolab-app-template" };
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey.slice(0, 256);
    const body = JSON.stringify({
      from: this.from, to: [to], subject: rendered.subject, text: rendered.text, html: rendered.html,
      tags: [{ name: "template", value: input.template.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) }],
    });

    let res: Response;
    try {
      res = await this.fetchImpl(ENDPOINT, { method: "POST", headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new MessagingError(timedOut ? `resend timeout after ${this.timeoutMs} ms` : "resend network error", timedOut ? "timeout" : "network", true);
    }

    const payload = (await res.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
    if (res.ok) {
      if (typeof payload.id !== "string" || !payload.id) throw new MessagingError("resend response without id", "bad_response", true, res.status);
      return { providerRef: payload.id };
    }
    throw mapError(res.status, typeof payload.name === "string" ? payload.name : "");
  }
}

/** Provider status + error name -> sanitized, classified error. Only a whitelisted name shape reaches the message. */
export function mapError(status: number, providerName: string): MessagingError {
  const name = /^[a-z_]{1,48}$/.test(providerName) ? providerName : "error";
  const msg = `resend ${status} ${name}`;
  if (status === 429) return new MessagingError(msg, "rate_limited", true, status);
  if (status === 401 || status === 403) return new MessagingError(msg, "auth", true, status); // a fixed key lets the outbox retries succeed
  if (status === 409) return new MessagingError(msg, "idempotency", name === "concurrent_idempotent_requests", status);
  if (status >= 500) return new MessagingError(msg, "provider_unavailable", true, status);
  return new MessagingError(msg, "rejected", false, status); // 400, 404, 422: the request itself is wrong
}
