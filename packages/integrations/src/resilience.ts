/**
 * Small, dependency-free resilience primitives for synchronous provider calls (payments, carrier quotes).
 * Asynchronous side effects (messaging) do not use them: the outbox worker owns retries and backoff for those.
 */

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export type RetryOptions = {
  /** Total attempts, including the first one. */
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Only errors for which this returns true are retried. */
  isRetryable: (err: unknown) => boolean;
  /** Absolute deadline (epoch ms): no retry is started if its backoff would end after it. */
  deadline?: number | undefined;
  sleep?: Sleep | undefined;
  random?: (() => number) | undefined;
  now?: (() => number) | undefined;
};

/** "Full jitter" backoff (AWS architecture blog): uniform in [0, min(maxMs, baseMs * 2^attempt)]. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt));
}

export async function retryWithJitter<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt + 1 >= o.attempts || !o.isRetryable(err)) throw err;
      const delay = backoffDelay(attempt, o.baseMs, o.maxMs, o.random);
      if (o.deadline !== undefined && now() + delay >= o.deadline) throw err;
      await sleep(delay);
    }
  }
}

export type CircuitState = "closed" | "open" | "half_open";

/**
 * Consecutive-failure circuit breaker. After `failureThreshold` failures in a row the circuit opens and calls fail fast
 * for `cooldownMs`; then one probe call is let through (half-open): success closes the circuit, failure re-opens it.
 * Only failures the caller reports (provider unavailable, timeouts) count; a request the provider answered and rejected
 * (4xx) proves the provider is up and counts as a success.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  constructor(private readonly opts: { failureThreshold: number; cooldownMs: number; now?: () => number }) {}

  private now() { return (this.opts.now ?? Date.now)(); }

  get state(): CircuitState {
    if (this.failures < this.opts.failureThreshold) return "closed";
    return this.now() - this.openedAt >= this.opts.cooldownMs ? "half_open" : "open";
  }

  /** True if a call may go out now. In half-open state only one probe at a time is allowed. */
  tryAcquire(): boolean {
    const s = this.state;
    if (s === "closed") return true;
    if (s === "open" || this.probing) return false;
    this.probing = true;
    return true;
  }

  onSuccess(): void { this.failures = 0; this.probing = false; }

  onFailure(): void {
    this.probing = false;
    this.failures++;
    if (this.failures >= this.opts.failureThreshold) this.openedAt = this.now();
  }
}
