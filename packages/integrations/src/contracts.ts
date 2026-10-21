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

export interface MessagingProvider {
  readonly name: string;
  send(input: { to: string; template: string; data: Record<string, unknown> }): Promise<{ providerRef: string }>;
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 300): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, baseMs * 2 ** i)); }
  }
  throw last;
}
