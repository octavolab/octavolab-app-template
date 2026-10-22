/**
 * Idempotency-Key management for writes that create orders or payments.
 *
 * The API binds a key to its request body (422 IDEMPOTENCY_MISMATCH if reused with another body) and replays the
 * stored result when the same key and body arrive again. So the client must:
 *  - reuse the SAME key when it retries the SAME request (network error, timeout, 5xx, double click), and
 *  - use a NEW key as soon as the request changes (the cart was edited) or after the request succeeded for good.
 * Keys live in memory only (never localStorage): a reload starts a fresh attempt, and the server-side state stays the source of truth.
 */
export type KeyGenerator = () => string;

export function randomKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback for non-secure contexts: RFC 4122 v4 from getRandomValues.
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class IdempotencyKeeper {
  private current: { fingerprint: string; key: string } | null = null;
  constructor(private readonly generate: KeyGenerator = randomKey) {}

  /** The key for this exact request: the same while the fingerprint is unchanged, a new one when it changes. */
  keyFor(fingerprint: string): string {
    if (!this.current || this.current.fingerprint !== fingerprint) this.current = { fingerprint, key: this.generate() };
    return this.current.key;
  }

  /** Call once the operation succeeded for good: the next request, even with an identical body, is a new operation. */
  reset(): void {
    this.current = null;
  }
}

/** Stable fingerprint of a cart: order-independent, so re-adding items in another order still retries with the same key. */
export function cartFingerprint(lines: { sku: string; qty: number }[]): string {
  return [...lines].sort((a, b) => a.sku.localeCompare(b.sku)).map((l) => `${l.sku}:${l.qty}`).join("|");
}
