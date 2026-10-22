import { describe, it, expect } from "vitest";
import { initSentry, scrubEvent, scrub } from "./sentry";

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("web sentry", () => {
  it("stays disabled when the API has no DSN, answers an error or is unreachable", async () => {
    expect(await initSentry(answer(200, { sentry: null }))).toBe(false);
    expect(await initSentry(answer(500, {}))).toBe(false);
    expect(await initSentry((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBe(false);
  });
  it("scrubs user, request details, emails and tokens", () => {
    const e = scrubEvent({ user: { email: "a@b.co" }, message: "x a@b.co", request: { url: "https://app/x?t=1", cookies: {}, headers: {}, data: {}, query_string: "t=1" },
      exception: { values: [{ value: "sk_test_abc failed" }, {}] }, breadcrumbs: [{ message: "Bearer abc", data: { url: "/api/v1/orders?cursor=x" } }, {}] });
    expect(e).toEqual({ message: "x [email]", request: { url: "https://app/x" }, exception: { values: [{ value: "[stripe-key] failed" }, {}] }, breadcrumbs: [{ message: "Bearer [redacted]", data: { url: "/api/v1/orders" } }, {}] });
    expect(scrubEvent({})).toEqual({});
    expect(scrub("ok")).toBe("ok");
  });
});
