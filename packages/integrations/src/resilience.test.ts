import { describe, it, expect, vi } from "vitest";
import { backoffDelay, retryWithJitter, CircuitBreaker, realSleep } from "./resilience.js";

describe("backoffDelay (full jitter)", () => {
  it("is uniform in [0, min(max, base * 2^attempt)]", () => {
    expect(backoffDelay(0, 100, 1000, () => 0.999)).toBe(99);
    expect(backoffDelay(3, 100, 1000, () => 0.5)).toBe(400);
    expect(backoffDelay(10, 100, 1000, () => 0.999)).toBe(999);
    expect(backoffDelay(2, 100, 1000, () => 0)).toBe(0);
  });
});

describe("retryWithJitter", () => {
  const retryable = (e: unknown) => (e as Error).message === "retry";
  it("retries retryable errors up to `attempts`, sleeping a jittered delay between them", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValueOnce(new Error("retry")).mockRejectedValueOnce(new Error("retry")).mockResolvedValue("ok");
    expect(await retryWithJitter(fn, { attempts: 3, baseMs: 100, maxMs: 1000, isRetryable: retryable, sleep, random: () => 0.5 })).toBe("ok");
    expect(sleep.mock.calls).toEqual([[50], [100]]);
    const always = vi.fn().mockRejectedValue(new Error("retry"));
    await expect(retryWithJitter(always, { attempts: 3, baseMs: 1, maxMs: 1, isRetryable: retryable, sleep })).rejects.toThrow("retry");
    expect(always).toHaveBeenCalledTimes(3);
  });
  it("does not retry non-retryable errors, nor past the deadline", async () => {
    const fatal = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(retryWithJitter(fatal, { attempts: 5, baseMs: 1, maxMs: 1, isRetryable: retryable })).rejects.toThrow("fatal");
    expect(fatal).toHaveBeenCalledTimes(1);
    const late = vi.fn().mockRejectedValue(new Error("retry"));
    await expect(retryWithJitter(late, { attempts: 5, baseMs: 1000, maxMs: 1000, isRetryable: retryable, deadline: 1_500, now: () => 1_000, random: () => 0.9 })).rejects.toThrow("retry");
    expect(late).toHaveBeenCalledTimes(1);
  });
  it("realSleep waits", async () => {
    const t = Date.now();
    await realSleep(5);
    expect(Date.now() - t).toBeGreaterThanOrEqual(4);
  });
});

describe("CircuitBreaker", () => {
  it("opens after N consecutive failures, fails fast during cooldown, then lets ONE probe through", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });
    expect(b.tryAcquire()).toBe(true);
    b.onFailure();
    expect(b.state).toBe("closed");
    b.onFailure();
    expect([b.state, b.tryAcquire()]).toEqual(["open", false]);
    now = 1000;
    expect(b.state).toBe("half_open");
    expect([b.tryAcquire(), b.tryAcquire()]).toEqual([true, false]);
    b.onFailure(); // probe failed: open again for a full cooldown
    expect([b.state, b.tryAcquire()]).toEqual(["open", false]);
    now = 2000;
    expect(b.tryAcquire()).toBe(true);
    b.onSuccess();
    expect([b.state, b.tryAcquire()]).toEqual(["closed", true]);
  });
  it("a success resets the consecutive count", () => {
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    b.onFailure(); b.onSuccess(); b.onFailure();
    expect(b.state).toBe("closed");
  });
});
