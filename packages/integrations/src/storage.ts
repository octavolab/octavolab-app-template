import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl as presign } from "@aws-sdk/s3-request-presigner";
import type { ObjectHead, SignedUrl, SignedUrlInput, StorageProvider } from "./contracts.js";
import { StorageError } from "./contracts.js";
import { DEFAULT_S3_REGION } from "./config.js";

/**
 * Object storage: a private Lightsail bucket (S3-compatible) in staging/production, memory in dev and tests.
 *
 * - Keys are built server-side only, namespaced by tenant: `tenants/{tenantId}/{purpose}/{uuid}.{ext}` (tenantKey).
 *   A client never chooses a key, so it cannot read or overwrite another tenant's objects.
 * - Uploads go browser -> bucket through a pre-signed PUT (presignTenantUpload) that expires in at most 15 minutes and
 *   signs the exact Content-Type and Content-Length, so the upload must match the type and size the server accepted.
 * - The S3 adapter uses ONLY the explicit bucket access key (S3_ACCESS_KEY / S3_SECRET_KEY: a Lightsail bucket access
 *   key, scoped to one bucket, not an IAM user). Lightsail containers cannot assume IAM roles, and the SDK's default
 *   credential chain is never consulted because `credentials` is always passed.
 */
export const MAX_PRESIGN_SECONDS = 15 * 60;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEY = /^tenants\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){1,8}$/;

/** `tenants/{tenantId}/{...parts}`; every part is a single safe path segment (no `/`, no `..`, no leading dot). */
export function tenantKey(tenantId: string, ...parts: string[]): string {
  if (!SEGMENT.test(tenantId)) throw new StorageError("invalid tenant id for a storage key", "invalid_key", false);
  if (parts.length === 0) throw new StorageError("a storage key needs at least one part after the tenant", "invalid_key", false);
  for (const p of parts) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(p) || p.includes("..")) throw new StorageError("invalid storage key part", "invalid_key", false);
  return ["tenants", tenantId, ...parts].join("/");
}

/** Every key the adapters accept must be a tenant key: a defence against a caller building one by hand. */
export function assertTenantKey(key: string): void {
  if (!KEY.test(key) || key.includes("..")) throw new StorageError("storage key must be tenants/{tenantId}/...", "invalid_key", false);
}

/** Content types accepted for uploads and their extension. Anything else is refused before a URL is signed. */
export const UPLOAD_TYPES: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "text/csv": "csv",
};
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type UploadRequest = { tenantId: string; purpose: string; contentType: string; contentLength: number; expiresInSeconds?: number; maxBytes?: number };

/** Validates type and size, builds the tenant key and returns a pre-signed PUT (default 10 minutes, max 15). */
export async function presignTenantUpload(storage: StorageProvider, r: UploadRequest): Promise<SignedUrl & { key: string }> {
  const ext = Object.prototype.hasOwnProperty.call(UPLOAD_TYPES, r.contentType) ? UPLOAD_TYPES[r.contentType] : undefined;
  if (!ext) throw new StorageError("content type not allowed", "content_type_not_allowed", false);
  const max = Math.min(r.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES * 10);
  if (!Number.isSafeInteger(r.contentLength) || r.contentLength <= 0 || r.contentLength > max) throw new StorageError("content length out of range", "too_large", false);
  if (!SEGMENT.test(r.purpose)) throw new StorageError("invalid upload purpose", "invalid_key", false);
  const key = tenantKey(r.tenantId, r.purpose, `${randomUUID()}.${ext}`);
  const signed = await storage.getSignedUrl({ method: "PUT", key, contentType: r.contentType, contentLength: r.contentLength, expiresInSeconds: r.expiresInSeconds ?? 600 });
  return { ...signed, key };
}

function checkExpiry(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PRESIGN_SECONDS) throw new StorageError(`pre-signed URL expiry must be 1..${MAX_PRESIGN_SECONDS} s`, "invalid_expiry", false);
  return seconds;
}

/** In-memory storage for dev, tests and demos. Signed URLs use the `memory:` scheme and are not fetchable. */
export class FakeStorage implements StorageProvider {
  readonly name = "fake-storage";
  readonly objects = new Map<string, { body: Uint8Array; contentType: string; etag: string }>();
  constructor(private readonly now: () => number = Date.now) {}

  async putObject(i: { key: string; body: Uint8Array | string; contentType: string }) {
    assertTenantKey(i.key);
    const body = typeof i.body === "string" ? new TextEncoder().encode(i.body) : i.body;
    const etag = `"fake-${body.byteLength}-${this.objects.size}"`;
    this.objects.set(i.key, { body, contentType: i.contentType, etag });
    return { key: i.key, etag };
  }

  async getSignedUrl(i: SignedUrlInput): Promise<SignedUrl> {
    assertTenantKey(i.key);
    const expiresAt = new Date(this.now() + checkExpiry(i.expiresInSeconds) * 1000);
    const headers: Record<string, string> = i.method === "PUT" ? { "Content-Type": i.contentType, "Content-Length": String(i.contentLength) } : {};
    return { url: `memory://fake-bucket/${i.key}?method=${i.method}&expires=${expiresAt.getTime()}`, method: i.method, expiresAt, headers };
  }

  async deleteObject(key: string) { assertTenantKey(key); this.objects.delete(key); }

  async headObject(key: string): Promise<ObjectHead | null> {
    assertTenantKey(key);
    const o = this.objects.get(key);
    return o ? { size: o.body.byteLength, contentType: o.contentType, etag: o.etag } : null;
  }
}

export type S3Options = {
  endpoint?: string | undefined;
  bucket?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  region?: string | undefined;
  /** Test seam: a client with the same `send` and config (the presigner signs locally, no network). */
  client?: S3Client | undefined;
  now?: (() => number) | undefined;
};

export class S3Storage implements StorageProvider {
  readonly name = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly now: () => number;

  constructor(opts: S3Options = {}) {
    const endpoint = opts.endpoint ?? process.env.S3_ENDPOINT;
    const bucket = opts.bucket ?? process.env.S3_BUCKET;
    const accessKeyId = opts.accessKeyId ?? process.env.S3_ACCESS_KEY;
    const secretAccessKey = opts.secretAccessKey ?? process.env.S3_SECRET_KEY;
    if (!endpoint) throw new Error("S3_ENDPOINT missing");
    if (!bucket) throw new Error("S3_BUCKET missing");
    if (!accessKeyId || !secretAccessKey) throw new Error("S3_ACCESS_KEY and S3_SECRET_KEY are required (bucket access key; no instance role exists on Lightsail)");
    this.bucket = bucket;
    this.now = opts.now ?? Date.now;
    this.client = opts.client ?? new S3Client({
      region: opts.region ?? process.env.S3_REGION ?? DEFAULT_S3_REGION,
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // Newer SDKs add CRC32 checksums to every PutObject; in a pre-signed URL that would force the browser to send a
      // checksum header it cannot compute. Only send checksums when the operation requires them.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
    });
  }

  async putObject(i: { key: string; body: Uint8Array | string; contentType: string }) {
    assertTenantKey(i.key);
    const r = await this.run(() => this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: i.key, Body: i.body, ContentType: i.contentType })));
    return { key: i.key, etag: r.ETag };
  }

  async getSignedUrl(i: SignedUrlInput): Promise<SignedUrl> {
    assertTenantKey(i.key);
    const expiresIn = checkExpiry(i.expiresInSeconds);
    const command = i.method === "PUT"
      ? new PutObjectCommand({ Bucket: this.bucket, Key: i.key, ContentType: i.contentType, ContentLength: i.contentLength })
      : new GetObjectCommand({ Bucket: this.bucket, Key: i.key });
    // content-type and content-length become signed headers: S3 rejects an upload whose type or size differ.
    const url = await presign(this.client, command, { expiresIn, ...(i.method === "PUT" ? { signableHeaders: new Set(["content-type", "content-length"]) } : {}) });
    const headers: Record<string, string> = i.method === "PUT" ? { "Content-Type": i.contentType, "Content-Length": String(i.contentLength) } : {};
    return { url, method: i.method, expiresAt: new Date(this.now() + expiresIn * 1000), headers };
  }

  async deleteObject(key: string) {
    assertTenantKey(key);
    await this.run(() => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })));
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    assertTenantKey(key);
    try {
      const r = await this.run(() => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType, etag: r.ETag };
    } catch (e) {
      if (e instanceof StorageError && e.status === 404) return null;
      throw e;
    }
  }

  /** Sends a command; SDK errors become StorageError without the provider's message (which can echo keys or ids). */
  private async run<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      const meta = (e as { $metadata?: { httpStatusCode?: number }; name?: string } | null) ?? {};
      const status = meta.$metadata?.httpStatusCode;
      const name = typeof meta.name === "string" && /^[A-Za-z]{1,64}$/.test(meta.name) ? meta.name : "Error";
      const retryable = status === undefined || status === 429 || status >= 500;
      throw new StorageError(`s3 ${status ?? "network"} ${name}`, status === 404 ? "not_found" : status === 403 ? "auth" : retryable ? "provider_unavailable" : "rejected", retryable, status);
    }
  }
}
