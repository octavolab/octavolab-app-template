/** Domain-facing contracts. The business code only talks to these; providers are adapters (Módulo C, 5.1). */
export type Money = { amount: number; currency: string };

export interface PaymentGateway {
  readonly name: string;
  createPaymentIntent(input: { orderId: string; money: Money; idempotencyKey: string }): Promise<{ providerRef: string; clientSecret?: string | undefined }>;
  /** Re-reads an existing intent (resume or replay a checkout) without creating a new one. */
  retrievePaymentIntent(providerRef: string): Promise<{ providerRef: string; clientSecret?: string | undefined; status: string }>;
  verifyWebhook(rawBody: string, signature: string): Promise<{ eventId: string; type: string; data: unknown }>;
  refund(input: { providerRef: string; money: Money; idempotencyKey: string }): Promise<{ providerRef: string }>;
  /** Cheap authenticated read proving the credentials work (health check). Throws on failure. */
  ping(): Promise<void>;
}

/** A failed payment provider call. Same shape and rules as MessagingError: sanitized message, never the key. */
export class PaymentError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message);
    this.name = "PaymentError";
  }
}

export type CarrierQuoteInput = { from: string; to: string; weightKg: number; volumetricKg: number };
export type CarrierQuote = { carrier: string; service: string; money: Money; etaDays?: number };

export interface CarrierRates {
  readonly name: string;
  quote(input: CarrierQuoteInput): Promise<CarrierQuote[]>;
}

/** A failed carrier call. `retryable` says whether asking again later can help; the message never holds the key. */
export class CarrierError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message);
    this.name = "CarrierError";
  }
}

/**
 * Object storage (private bucket). Keys are always built server-side with `tenantKey` (storage.ts): `tenants/{tenantId}/...`.
 * Browsers never receive credentials, only pre-signed URLs that expire in at most 15 minutes.
 */
export type ObjectHead = { size: number; contentType: string | undefined; etag: string | undefined };
export type SignedUrlInput =
  | { method: "GET"; key: string; expiresInSeconds: number }
  | { method: "PUT"; key: string; expiresInSeconds: number; contentType: string; contentLength: number };
export type SignedUrl = { url: string; method: "GET" | "PUT"; expiresAt: Date; headers: Record<string, string> };

export interface StorageProvider {
  readonly name: string;
  putObject(input: { key: string; body: Uint8Array | string; contentType: string }): Promise<{ key: string; etag: string | undefined }>;
  getSignedUrl(input: SignedUrlInput): Promise<SignedUrl>;
  deleteObject(key: string): Promise<void>;
  /** null when the object does not exist. */
  headObject(key: string): Promise<ObjectHead | null>;
}

export class StorageError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message);
    this.name = "StorageError";
  }
}

export type MessageInput = {
  to: string;
  template: string;
  data: Record<string, unknown>;
  /** Provider-side deduplication (e.g. `outbox:<eventId>`): a retried send with the same key is not delivered twice. */
  idempotencyKey?: string | undefined;
};

export interface MessagingProvider {
  readonly name: string;
  send(input: MessageInput): Promise<{ providerRef: string }>;
}

/**
 * A failed send. `retryable` tells the caller (the outbox worker) whether trying again can help: false means the request
 * itself is wrong (invalid recipient, unknown template, idempotency conflict) and the event should be dead-lettered now.
 * The message never contains the API key, the recipient or the provider's free-text error (which can echo the address).
 */
export class MessagingError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message);
    this.name = "MessagingError";
  }
}
