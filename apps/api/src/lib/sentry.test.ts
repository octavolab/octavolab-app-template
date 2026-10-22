import { describe, it, expect } from "vitest";
import type { ErrorEvent } from "@sentry/node";
import { sentryOptions, scrubEvent, scrubString, scrubBreadcrumb, tracesSampleRate } from "./sentry.js";

describe("sentry options", () => {
  it("is disabled without SENTRY_DSN", () => {
    expect(sentryOptions({}, "api")).toBeUndefined();
  });
  it("uses APP_ENV, APP_VERSION, no default PII and 0.1 traces on staging", () => {
    const o = sentryOptions({ SENTRY_DSN: "https://pub@o1.ingest.us.sentry.io/1", APP_ENV: "staging", APP_VERSION: "v0.8.0-3-gabc" }, "worker")!;
    expect(o).toMatchObject({ environment: "staging", release: "v0.8.0-3-gabc", sendDefaultPii: false, tracesSampleRate: 0.1, serverName: "worker", initialScope: { tags: { service: "worker" } } });
    expect(sentryOptions({ SENTRY_DSN: "https://pub@o1.ingest.us.sentry.io/1" }, "api")).toMatchObject({ environment: "local", release: "dev" });
  });
  it("sample rate: explicit value in [0, 1] wins; otherwise 0.05 in production and 0.1 elsewhere", () => {
    expect([tracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "0.3" }), tracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "7", APP_ENV: "production" }), tracesSampleRate({ SENTRY_TRACES_SAMPLE_RATE: "" }), tracesSampleRate({ APP_ENV: "production" })]).toEqual([0.3, 0.05, 0.1, 0.05]);
  });
});

describe("scrubbing", () => {
  it("removes provider secrets, bearer tokens, connection-string passwords and emails from strings", () => {
    const awsId = ["AKIA", "ABCDEFGHIJKLMNOP"].join(""); // built at runtime so secret scanners do not flag a fake id
    const s = scrubString(`key sk_live_abc123 rk_test_x1 whsec_abc re_abcdef_123 ${awsId} Bearer eyJ.a.b postgresql://app:pw@db:5432/x jaime@example.com`);
    expect(s).toBe("key [stripe-key] [stripe-key] [webhook-secret] [resend-key] [aws-key-id] Bearer [redacted] postgresql://[redacted]@db:5432/x [email]");
  });
  it("drops user, cookies, body and query; scrubs headers, messages, exceptions, extra, contexts, breadcrumbs and transaction", () => {
    const event = {
      user: { email: "a@b.co", ip_address: "1.2.3.4" },
      message: "failed for a@b.co",
      request: { url: "https://app/x?token=abc", cookies: { sid: "s" }, data: { password: "p" }, query_string: "token=abc", headers: { authorization: "Bearer t", "stripe-signature": "t=1", "user-agent": "ua" } },
      exception: { values: [{ type: "Error", value: "stripe sk_test_abc failed" }, { type: "Error" }] },
      extra: { nested: { apiKey: "x", note: "mail ops@x.co" }, list: ["sk_live_q1"] },
      contexts: { app: { session: "x" } },
      breadcrumbs: [{ message: "GET /x", data: { url: "https://api.stripe.com/v1/balance?x=1", Authorization: "Bearer y" } }, { category: "c" }],
      transaction: "GET /api/v1/orders?cursor=x",
    } as unknown as ErrorEvent;
    const out = scrubEvent(event) as unknown as Record<string, any>;
    expect(out.user).toBeUndefined();
    expect(out.request).toEqual({ url: "https://app/x", headers: { authorization: "[redacted]", "stripe-signature": "[redacted]", "user-agent": "ua" } });
    expect(out.message).toBe("failed for [email]");
    expect(out.exception.values[0].value).toBe("stripe [stripe-key] failed");
    expect(out.extra).toEqual({ nested: { apiKey: "[redacted]", note: "mail [email]" }, list: ["[stripe-key]"] });
    expect(out.contexts).toEqual({ app: { session: "[redacted]" } });
    expect(out.breadcrumbs[0]).toEqual({ message: "GET /x", data: { url: "https://api.stripe.com/v1/balance", Authorization: "[redacted]" } });
    expect(out.transaction).toBe("GET /api/v1/orders");
    expect(scrubEvent({} as ErrorEvent)).toEqual({});
    expect(scrubEvent({ request: {} } as ErrorEvent)).toEqual({ request: {} });
  });
  it("hooks in the options scrub too", () => {
    const o = sentryOptions({ SENTRY_DSN: "https://pub@o1.ingest.us.sentry.io/1" }, "api")!;
    expect((o.beforeSend!({ message: "a@b.co" } as ErrorEvent, {}) as ErrorEvent).message).toBe("[email]");
    expect((o.beforeSendTransaction!({ transaction: "GET /x?y" } as never, {}) as { transaction: string }).transaction).toBe("GET /x");
    expect(o.beforeBreadcrumb!({ message: "re_secretkey1" }, {})).toEqual({ message: "[resend-key]" });
    expect(scrubBreadcrumb({ data: { n: 1 } })).toEqual({ data: { n: 1 } });
  });
});
