/**
 * A sliding window per caller.
 *
 * Chat and party invites carry their own limits, tuned to what those actions
 * cost. This is the backstop for everything else that writes: registering
 * teams, applying to them, posting scrim listings, deciding requests. None of
 * those is expensive on its own, and none is something a person does twice a
 * second.
 *
 * In memory, like the chat limiter and the socket table, because the server is
 * one process. Spreading across several would need this in Redis along with
 * everything else that is currently per-process -- see the note in the README
 * about that ceiling.
 */
export interface RateLimitVerdict {
  ok: boolean;
  /** How long until the next attempt would be allowed. Zero when ok. */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowSeconds: number,
  ) {}

  /** Records an attempt and says whether it is allowed. */
  take(key: string, now = Date.now()): RateLimitVerdict {
    const windowMs = this.windowSeconds * 1000;
    const cutoff = now - windowMs;

    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.limit) {
      // The oldest hit in the window is the one whose expiry frees a slot.
      const waitMs = recent[0]! + windowMs - now;
      this.hits.set(key, recent);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true, retryAfterSeconds: 0 };
  }

  /** Drops a caller's history. Used when their session ends. */
  forget(key: string): void {
    this.hits.delete(key);
  }

  /**
   * Drops histories that have fallen entirely outside the window.
   *
   * Without this the map keeps a key for every account that ever wrote
   * anything, which on a long-running server is a slow leak rather than a
   * limiter.
   */
  prune(now = Date.now()): number {
    const cutoff = now - this.windowSeconds * 1000;
    let dropped = 0;

    for (const [key, times] of [...this.hits]) {
      const recent = times.filter((at) => at > cutoff);
      if (recent.length === 0) {
        this.hits.delete(key);
        dropped += 1;
      } else if (recent.length !== times.length) {
        this.hits.set(key, recent);
      }
    }
    return dropped;
  }

  /** How many callers are being tracked. For tests and diagnostics. */
  size(): number {
    return this.hits.size;
  }
}
