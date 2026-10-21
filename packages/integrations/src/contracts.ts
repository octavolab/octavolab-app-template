/** Domain-facing contracts. The business code only talks to these; providers are adapters (Módulo C, 5.1). */
export type Money = { amount: number; currency: string };

export interface PaymentGateway {
  readonly name: string;
  createPaymentIntent(input: { orderId: string; money: Money; idempotencyKey: string }): Promise<{ providerRef: string; clientSecret?: string | undefined }>;
  /** Re-reads an existing intent (resume or replay a checkout) without creating a new one. */
  retrievePaymentIntent(providerRef: string): Promise<{ providerRef: string; clientSecret?: string | undefined; status: string }>;
  verifyWebhook(rawBody: string, signature: string): Promise<{ eventId: string; type: string; data: unknown }>;
  refund(input: { providerRef: string; money: Money; idempotencyKey: string }): Promise<{ providerRef: string }>;
}

export interface CarrierRates {
  readonly name: string;
  quote(input: { from: string; to: string; weightKg: number; volumetricKg: number }): Promise<{ carrier: string; service: string; money: Money; etaDays?: number }[]>;
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

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 300): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, baseMs * 2 ** i)); }
  }
  throw last;
}
