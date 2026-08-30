import { describe, expect, it } from "vitest";

import { RateLimiter } from "./rate-limit.js";

describe("a sliding window", () => {
  it("allows a burst up to the limit", () => {
    const limiter = new RateLimiter(3, 60);
    const now = Date.now();

    expect(limiter.take("a", now).ok).toBe(true);
    expect(limiter.take("a", now).ok).toBe(true);
    expect(limiter.take("a", now).ok).toBe(true);
    expect(limiter.take("a", now).ok).toBe(false);
  });

  it("says how long to wait, rather than just no", () => {
    const limiter = new RateLimiter(1, 60);
    const now = Date.now();
    limiter.take("a", now);

    const denied = limiter.take("a", now + 10_000);
    expect(denied.ok).toBe(false);
    // 60 second window, 10 seconds in: 50 to go.
    expect(denied.retryAfterSeconds).toBe(50);
  });

  it("never says to wait zero seconds while refusing", () => {
    const limiter = new RateLimiter(1, 60);
    const now = Date.now();
    limiter.take("a", now);

    // A refusal telling you to retry immediately is a refusal that gets retried
    // immediately, in a loop.
    const denied = limiter.take("a", now + 59_999);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("frees a slot as the window slides, not all at once", () => {
    const limiter = new RateLimiter(2, 60);
    const now = Date.now();
    limiter.take("a", now);
    limiter.take("a", now + 30_000);

    expect(limiter.take("a", now + 40_000).ok).toBe(false);
    // The first hit has aged out by now; the second has not.
    expect(limiter.take("a", now + 61_000).ok).toBe(true);
    expect(limiter.take("a", now + 61_000).ok).toBe(false);
  });

  it("counts each caller separately", () => {
    const limiter = new RateLimiter(1, 60);
    const now = Date.now();

    expect(limiter.take("a", now).ok).toBe(true);
    expect(limiter.take("b", now).ok).toBe(true);
    expect(limiter.take("a", now).ok).toBe(false);
  });

  it("forgets a caller on request", () => {
    const limiter = new RateLimiter(1, 60);
    const now = Date.now();
    limiter.take("a", now);

    limiter.forget("a");
    expect(limiter.take("a", now).ok).toBe(true);
  });
});

describe("not leaking callers", () => {
  it("drops histories that have aged out entirely", () => {
    const limiter = new RateLimiter(5, 60);
    const now = Date.now();
    limiter.take("a", now);
    limiter.take("b", now);
    expect(limiter.size()).toBe(2);

    // Otherwise the map keeps a key for every account that ever wrote
    // anything, which is a slow leak rather than a limiter.
    expect(limiter.prune(now + 61_000)).toBe(2);
    expect(limiter.size()).toBe(0);
  });

  it("keeps a caller who is still inside the window", () => {
    const limiter = new RateLimiter(5, 60);
    const now = Date.now();
    limiter.take("a", now);
    limiter.take("b", now + 50_000);

    expect(limiter.prune(now + 61_000)).toBe(1);
    expect(limiter.size()).toBe(1);
  });

  it("trims stale hits from a caller it keeps", () => {
    const limiter = new RateLimiter(2, 60);
    const now = Date.now();
    limiter.take("a", now);
    limiter.take("a", now + 55_000);

    limiter.prune(now + 61_000);
    // One of the two aged out, so there is room again without a full reset.
    expect(limiter.take("a", now + 61_000).ok).toBe(true);
  });
});
