import type { Notifier } from "./notifier.js";

/** The three numbers in the header strip. */
export interface Counts {
  online: number;
  inQueue: number;
  inMatch: number;
}

export interface PopulationOptions {
  /**
   * How long to gather changes before sending. Ten people connecting at once
   * is one broadcast, not ten.
   */
  coalesceMs?: number;
  /**
   * How often to recompute unprompted.
   *
   * Every caller that moves a number is supposed to nudge, and one that forgets
   * would otherwise leave a wrong number on screen until something unrelated
   * happened. This bounds that mistake at one sweep. It costs two queries a
   * sweep for the whole server -- not two per client -- and broadcasts nothing
   * when the numbers agree, which is almost always.
   */
  sweepMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Keeps everyone's population counters current over the socket.
 *
 * These three numbers move for reasons that never reach you: a stranger
 * connecting, two other parties matching. The client used to poll for them,
 * which cost two queries per signed-in client every eight seconds and still
 * showed a number up to eight seconds stale. This inverts it -- the server
 * knows the moment a count changes, so it says so, and says nothing when
 * nothing has changed.
 */
export class Population {
  private last: Counts | null = null;
  private coalesce: ReturnType<typeof setTimeout> | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private dirty = false;

  private readonly coalesceMs: number;
  private readonly sweepMs: number;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly notifier: Notifier,
    private readonly read: () => Promise<Counts>,
    options: PopulationOptions = {},
  ) {
    this.coalesceMs = options.coalesceMs ?? 250;
    this.sweepMs = options.sweepMs ?? 30_000;
    this.onError = options.onError ?? (() => {});
  }

  /** Something that could have moved a number just happened. */
  nudge(): void {
    if (this.coalesce) return;
    this.coalesce = setTimeout(() => {
      this.coalesce = null;
      void this.refresh();
    }, this.coalesceMs);
    this.coalesce.unref?.();
  }

  /**
   * Tells one user what the numbers are, without a query.
   *
   * A second window for someone already online moves nothing, so the broadcast
   * their connection triggers would not be sent -- and that window would sit on
   * placeholder numbers until somebody else's action rescued it.
   */
  greet(userId: string): void {
    if (!this.last) return;
    // The stored count predates this connection, and the one number that has
    // certainly just changed is the one that costs nothing to get right: an
    // arrival being told "0 online" for a quarter second, then corrected, is
    // the flash of an empty playerbase this all exists to avoid.
    const online = this.notifier.onlineCount();
    this.notifier.toUser(userId, { type: "queue.counts", ...this.last, online });
  }

  /** The current numbers, computed fresh. */
  async current(): Promise<Counts> {
    const counts = await this.read();
    this.last = counts;
    return counts;
  }

  /** What was last sent, if anything has been. */
  snapshot(): Counts | null {
    return this.last;
  }

  /** Recomputes, and broadcasts only if that changed anything. */
  async refresh(): Promise<void> {
    if (this.running) {
      // Whatever prompted this happened after the in-flight read started, so
      // that read may already be out of date. Go round again once it lands.
      this.dirty = true;
      return;
    }

    this.running = true;
    try {
      const counts = await this.read();
      if (!this.last || !same(this.last, counts)) {
        this.last = counts;
        this.notifier.broadcast({ type: "queue.counts", ...counts });
      }
    } catch (err) {
      // A failed read leaves the last known numbers up. They are stale, which
      // is better than zeroes that read as an empty playerbase.
      this.onError(err);
    } finally {
      this.running = false;
      if (this.dirty) {
        this.dirty = false;
        this.nudge();
      }
    }
  }

  start(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => void this.refresh(), this.sweepMs);
    this.sweep.unref?.();
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep);
    if (this.coalesce) clearTimeout(this.coalesce);
    this.sweep = null;
    this.coalesce = null;
  }
}

function same(a: Counts, b: Counts): boolean {
  return a.online === b.online && a.inQueue === b.inQueue && a.inMatch === b.inMatch;
}
