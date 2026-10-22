import { describe, it, expect, vi, afterEach } from "vitest";
import { ResendMessaging, RESEND_SANDBOX_RECIPIENT, mapError } from "./resend.js";
import { MessagingError } from "./contracts.js";
import { renderTemplate } from "./templates.js";

const KEY = "re_TestKey_123456789";
const FROM = "OctavoLab <noreply@example.com>";
type Call = { url: string; init: RequestInit };

/** fetch double: records calls and answers with the given status and JSON body (or throws the given error). */
function fakeFetch(answer: { status: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? "not json" : JSON.stringify(answer.body), { status: answer.status });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}
const adapter = (f: ReturnType<typeof fakeFetch>, sandbox = false, extra: Partial<ConstructorParameters<typeof ResendMessaging>[0]> = {}) =>
  new ResendMessaging({ apiKey: KEY, from: FROM, sandbox, fetchImpl: f.impl, ...extra });
const input = { to: "ops@client.example", template: "order_paid", data: { orderId: "o-42" }, idempotencyKey: "outbox:e1" };

afterEach(() => { delete process.env.RESEND_API_KEY; delete process.env.MESSAGING_FROM; });

describe("ResendMessaging", () => {
  it("POSTs JSON to the Resend emails endpoint with bearer auth, idempotency key, rendered subject and bodies", async () => {
    const f = fakeFetch({ status: 200, body: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" } });
    expect(await adapter(f).send(input)).toEqual({ providerRef: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
    const [call] = f.calls;
    expect(call!.url).toBe("https://api.resend.com/emails");
    expect(call!.init.method).toBe("POST");
    const h = call!.init.headers as Record<string, string>;
    expect([h.Authorization, h["Content-Type"], h["Idempotency-Key"]]).toEqual([`Bearer ${KEY}`, "application/json", "outbox:e1"]);
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(call!.init.body));
    expect(body).toMatchObject({ from: FROM, to: ["ops@client.example"], subject: "Order o-42 paid", text: "Order o-42 was paid.", tags: [{ name: "template", value: "order_paid" }] });
    expect(body.html).toContain("<p>Order o-42 was paid.</p>");
  });

  it("sandbox mode never emails a real recipient: it is replaced by Resend's test inbox", async () => {
    const f = fakeFetch({ status: 200, body: { id: "id-1" } });
    await adapter(f, true).send(input);
    await adapter(f, true).send({ ...input, to: "bounced@resend.dev" });
    expect(f.calls.map((c) => JSON.parse(String(c.init.body)).to)).toEqual([[RESEND_SANDBOX_RECIPIENT], ["bounced@resend.dev"]]);
  });

  it("sandbox delivers to MESSAGING_ALLOW_LIST addresses as is (exact, case-insensitive); everyone else gets the test inbox", async () => {
    const f = fakeFetch({ status: 200, body: { id: "id-1" } });
    const a = adapter(f, true, { allowList: [" Jaime@Example.com ", ""] });
    await a.send({ ...input, to: "jaime@example.com" });
    await a.send({ ...input, to: "JAIME@example.com" });
    await a.send({ ...input, to: "jaime@example.com.evil.co" });
    await a.send({ ...input, to: "other@example.com" });
    expect(f.calls.map((c) => JSON.parse(String(c.init.body)).to[0])).toEqual(["jaime@example.com", "JAIME@example.com", RESEND_SANDBOX_RECIPIENT, RESEND_SANDBOX_RECIPIENT]);
    const live = fakeFetch({ status: 200, body: { id: "id-2" } });
    await adapter(live, false, { allowList: [] }).send(input);
    expect(JSON.parse(String(live.calls[0]!.init.body)).to).toEqual(["ops@client.example"]);
  });

  it("maps provider errors: 4xx request errors are permanent, 401/403/409-concurrent/429/5xx are retryable", async () => {
    const cases: [number, string, string, boolean][] = [
      [422, "validation_error", "rejected", false], [400, "invalid_idempotency_key", "rejected", false], [404, "not_found", "rejected", false],
      [401, "missing_api_key", "auth", true], [403, "invalid_api_key", "auth", true],
      [409, "invalid_idempotent_request", "idempotency", false], [409, "concurrent_idempotent_requests", "idempotency", true],
      [429, "rate_limit_exceeded", "rate_limited", true], [500, "internal_server_error", "provider_unavailable", true], [503, "", "provider_unavailable", true],
    ];
    for (const [status, name, code, retryable] of cases) {
      const err = await adapter(fakeFetch({ status, body: { statusCode: status, name, message: "The `to` field must be a valid email: ops@client.example" } })).send(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MessagingError);
      expect(err).toMatchObject({ code, retryable, status, message: `resend ${status} ${name || "error"}` });
    }
  });

  it("never puts the API key, the recipient or the provider's free text in an error message", async () => {
    const leaky = { statusCode: 422, name: `bad ${KEY} ops@client.example`, message: `ops@client.example ${KEY}` };
    const err = (await adapter(fakeFetch({ status: 422, body: leaky })).send(input).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("resend 422 error");
    const net = (await adapter(fakeFetch(new TypeError(`connect ECONNREFUSED ${KEY}`))).send(input).catch((e: unknown) => e)) as MessagingError;
    expect([net.message, net.code, net.retryable]).toEqual(["resend network error", "network", true]);
    for (const e of [err, net]) { expect(String(e.stack)).not.toContain(KEY); expect(e.message).not.toContain("ops@client.example"); }
  });

  it("times out a slow provider (retryable) instead of holding the outbox lease", async () => {
    const slow = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
    })) as unknown as typeof fetch;
    const err = (await new ResendMessaging({ apiKey: KEY, from: FROM, sandbox: false, fetchImpl: slow, timeoutMs: 20 }).send(input).catch((e: unknown) => e)) as MessagingError;
    expect([err.code, err.retryable, err.message]).toEqual(["timeout", true, "resend timeout after 20 ms"]);
  });

  it("rejects an invalid recipient or unknown template before calling the provider (permanent)", async () => {
    const f = fakeFetch({ status: 200, body: { id: "x" } });
    await expect(adapter(f).send({ ...input, to: "not-an-email" })).rejects.toMatchObject({ code: "invalid_recipient", retryable: false });
    await expect(adapter(f).send({ ...input, to: "a@b.co\r\nBcc: x@y.co" })).rejects.toMatchObject({ code: "invalid_recipient" });
    await expect(adapter(f).send({ ...input, template: "__proto__" })).rejects.toMatchObject({ code: "unknown_template", retryable: false });
    expect(f.calls.length).toBe(0);
  });

  it("treats a 2xx without an id as a retryable bad response", async () => {
    await expect(adapter(fakeFetch({ status: 200, body: {} })).send(input)).rejects.toMatchObject({ code: "bad_response", retryable: true });
    await expect(adapter(fakeFetch({ status: 200 })).send(input)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("reads RESEND_API_KEY and MESSAGING_FROM from the environment and refuses to build without them, never echoing the key", () => {
    expect(() => new ResendMessaging({ sandbox: true })).toThrow("RESEND_API_KEY missing");
    process.env.RESEND_API_KEY = "sk_live_wrong_provider_key";
    expect(() => new ResendMessaging({ sandbox: true })).toThrow(/^RESEND_API_KEY has an unexpected format$/);
    process.env.RESEND_API_KEY = KEY;
    expect(() => new ResendMessaging({ sandbox: true })).toThrow("MESSAGING_FROM missing");
    process.env.MESSAGING_FROM = FROM;
    expect(new ResendMessaging({ sandbox: true }).name).toBe("resend");
  });

  it("mapError only lets a lower-case error name through", () => {
    expect(mapError(422, "<script>").message).toBe("resend 422 error");
  });
});

describe("templates", () => {
  it("escapes HTML and strips line breaks from data values", () => {
    const r = renderTemplate("order_created", { orderId: "<b>x</b>\r\nBcc: evil@x.co" });
    expect(r.subject).toBe("Order <b>x</b> Bcc: evil@x.co created");
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(r.html).not.toContain("<b>x</b>");
    expect(renderTemplate("order_paid", {}).subject).toBe("Order (unknown) paid");
  });
});
