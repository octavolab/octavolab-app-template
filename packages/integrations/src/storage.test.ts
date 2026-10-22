import { describe, it, expect, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { FakeStorage, S3Storage, tenantKey, assertTenantKey, presignTenantUpload, MAX_PRESIGN_SECONDS, DEFAULT_MAX_UPLOAD_BYTES } from "./storage.js";
import { StorageError } from "./contracts.js";

const ENDPOINT = "https://s3.eu-west-2.amazonaws.com";
const creds = { endpoint: ENDPOINT, bucket: "octavolab-staging-files", accessKeyId: "TESTACCESSKEYID00000", secretAccessKey: "test-secret-xxx" };

describe("tenant keys", () => {
  it("builds tenants/{tenantId}/... from safe segments only", () => {
    expect(tenantKey("t_1", "invoices", "a.pdf")).toBe("tenants/t_1/invoices/a.pdf");
    for (const bad of [["../x", "a"], ["t1", "../a"], ["t1", "a/b"], ["t1", ".hidden"], ["t1", "a..b"], ["t/1", "a"], ["t1"]]) {
      expect(() => tenantKey(bad[0]!, ...bad.slice(1))).toThrow(StorageError);
    }
  });
  it("adapters refuse any key outside the tenant namespace", () => {
    expect(() => assertTenantKey("tenants/t1/x.pdf")).not.toThrow();
    for (const k of ["x.pdf", "tenants/t1", "tenants/t1/../t2/x", "/tenants/t1/x", "tenants/t1/x/"]) expect(() => assertTenantKey(k)).toThrow("tenants/{tenantId}");
  });
});

describe("FakeStorage", () => {
  it("puts, heads, signs and deletes in memory", async () => {
    const s = new FakeStorage(() => 0);
    const key = tenantKey("t1", "docs", "a.txt");
    expect((await s.putObject({ key, body: "hello", contentType: "text/plain" })).key).toBe(key);
    await s.putObject({ key: tenantKey("t1", "docs", "b.bin"), body: new Uint8Array([1, 2]), contentType: "application/octet-stream" });
    expect(await s.headObject(key)).toMatchObject({ size: 5, contentType: "text/plain" });
    const get = await s.getSignedUrl({ method: "GET", key, expiresInSeconds: 60 });
    expect([get.url.startsWith("memory://fake-bucket/tenants/t1/docs/a.txt"), get.expiresAt.getTime(), get.headers]).toEqual([true, 60_000, {}]);
    await s.deleteObject(key);
    expect(await s.headObject(key)).toBeNull();
    await expect(s.getSignedUrl({ method: "GET", key, expiresInSeconds: MAX_PRESIGN_SECONDS + 1 })).rejects.toMatchObject({ code: "invalid_expiry" });
    await expect(s.putObject({ key: "other/x", body: "", contentType: "text/plain" })).rejects.toThrow(StorageError);
  });
});

describe("presignTenantUpload", () => {
  it("signs a PUT under the tenant namespace with exact type and size headers", async () => {
    const r = await presignTenantUpload(new FakeStorage(() => 0), { tenantId: "t1", purpose: "proof-of-delivery", contentType: "application/pdf", contentLength: 1234 });
    expect(r.key).toMatch(/^tenants\/t1\/proof-of-delivery\/[0-9a-f-]{36}\.pdf$/);
    expect(r.headers).toEqual({ "Content-Type": "application/pdf", "Content-Length": "1234" });
    expect([r.method, r.expiresAt.getTime()]).toEqual(["PUT", 600_000]);
  });
  it("refuses other content types, empty or oversized bodies, bad purposes and expiries over 15 minutes", async () => {
    const s = new FakeStorage();
    const base = { tenantId: "t1", purpose: "docs", contentType: "image/png", contentLength: 10 };
    await expect(presignTenantUpload(s, { ...base, contentType: "text/html" })).rejects.toMatchObject({ code: "content_type_not_allowed" });
    await expect(presignTenantUpload(s, { ...base, contentType: "__proto__" })).rejects.toMatchObject({ code: "content_type_not_allowed" });
    await expect(presignTenantUpload(s, { ...base, contentLength: 0 })).rejects.toMatchObject({ code: "too_large" });
    await expect(presignTenantUpload(s, { ...base, contentLength: DEFAULT_MAX_UPLOAD_BYTES + 1 })).rejects.toMatchObject({ code: "too_large" });
    await expect(presignTenantUpload(s, { ...base, contentLength: 2000, maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
    await expect(presignTenantUpload(s, { ...base, purpose: "../x" })).rejects.toMatchObject({ code: "invalid_key" });
    await expect(presignTenantUpload(s, { ...base, expiresInSeconds: 901 })).rejects.toMatchObject({ code: "invalid_expiry" });
  });
});

describe("S3Storage (Lightsail bucket)", () => {
  it("pre-signs locally (no network) with explicit bucket credentials, ≤ 15 min, signing content-type and content-length", async () => {
    const s = new S3Storage({ ...creds, now: () => 0 });
    const put = await s.getSignedUrl({ method: "PUT", key: "tenants/t1/docs/a.pdf", contentType: "application/pdf", contentLength: 42, expiresInSeconds: 900 });
    const u = new URL(put.url);
    expect(u.hostname).toBe("octavolab-staging-files.s3.eu-west-2.amazonaws.com");
    expect(u.pathname).toBe("/tenants/t1/docs/a.pdf");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-Credential")).toMatch(/^TESTACCESSKEYID00000\/\d{8}\/eu-west-2\/s3\/aws4_request$/);
    expect(u.searchParams.get("X-Amz-SignedHeaders")!.split(";")).toEqual(expect.arrayContaining(["content-length", "content-type", "host"]));
    expect([...u.searchParams.keys()].some((k) => k.toLowerCase().includes("checksum"))).toBe(false);
    expect([put.headers, put.expiresAt.getTime()]).toEqual([{ "Content-Type": "application/pdf", "Content-Length": "42" }, 900_000]);
    const get = await s.getSignedUrl({ method: "GET", key: "tenants/t1/docs/a.pdf", expiresInSeconds: 60 });
    expect(new URL(get.url).searchParams.get("X-Amz-Expires")).toBe("60");
    await expect(s.getSignedUrl({ method: "GET", key: "tenants/t1/docs/a.pdf", expiresInSeconds: 3600 })).rejects.toMatchObject({ code: "invalid_expiry" });
  });

  it("sends Put, Delete and Head commands to the configured bucket and maps SDK errors without their message", async () => {
    const send = vi.fn();
    const client = new S3Client({ region: "eu-west-2", endpoint: ENDPOINT, credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey } });
    client.send = send as unknown as S3Client["send"];
    const s = new S3Storage({ ...creds, client });
    send.mockResolvedValueOnce({ ETag: '"e1"' });
    expect(await s.putObject({ key: "tenants/t1/a.txt", body: "x", contentType: "text/plain" })).toEqual({ key: "tenants/t1/a.txt", etag: '"e1"' });
    expect(send.mock.calls[0]![0].input).toEqual({ Bucket: creds.bucket, Key: "tenants/t1/a.txt", Body: "x", ContentType: "text/plain" });
    send.mockResolvedValueOnce({});
    await s.deleteObject("tenants/t1/a.txt");
    expect(send.mock.calls[1]![0].constructor.name).toBe("DeleteObjectCommand");
    send.mockResolvedValueOnce({ ContentLength: 3, ContentType: "text/plain", ETag: '"e1"' });
    expect(await s.headObject("tenants/t1/a.txt")).toEqual({ size: 3, contentType: "text/plain", etag: '"e1"' });
    send.mockResolvedValueOnce({});
    expect(await s.headObject("tenants/t1/a.txt")).toEqual({ size: 0, contentType: undefined, etag: undefined });
    const sdkError = (status: number | undefined, name: string) => Object.assign(new Error(`secret ${creds.secretAccessKey} tenants/t1/a.txt`), { name, $metadata: status ? { httpStatusCode: status } : {} });
    send.mockRejectedValueOnce(sdkError(404, "NotFound"));
    expect(await s.headObject("tenants/t1/missing.txt")).toBeNull();
    for (const [status, name, code, retryable] of [[403, "AccessDenied", "auth", false], [503, "SlowDown", "provider_unavailable", true], [400, "Bad Request!", "rejected", false], [undefined, "TimeoutError", "provider_unavailable", true]] as const) {
      send.mockRejectedValueOnce(sdkError(status, name));
      const err = (await s.headObject("tenants/t1/a.txt").catch((e: unknown) => e)) as StorageError;
      expect([err.code, err.retryable]).toEqual([code, retryable]);
      expect(err.message).not.toContain(creds.secretAccessKey);
    }
    send.mockRejectedValueOnce(sdkError(400, "Bad Request!"));
    await expect(s.deleteObject("tenants/t1/a.txt")).rejects.toMatchObject({ message: "s3 400 Error" });
  });

  it("reads S3_* from the environment and refuses to build without explicit credentials (no default chain)", () => {
    const prev = { ...process.env };
    try {
      for (const k of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_REGION"]) delete process.env[k];
      expect(() => new S3Storage()).toThrow("S3_ENDPOINT missing");
      process.env.S3_ENDPOINT = ENDPOINT;
      expect(() => new S3Storage()).toThrow("S3_BUCKET missing");
      process.env.S3_BUCKET = creds.bucket;
      expect(() => new S3Storage()).toThrow("S3_ACCESS_KEY and S3_SECRET_KEY are required");
      Object.assign(process.env, { S3_ACCESS_KEY: creds.accessKeyId, S3_SECRET_KEY: creds.secretAccessKey });
      expect(new S3Storage().name).toBe("s3");
    } finally {
      process.env = prev;
    }
  });
});
