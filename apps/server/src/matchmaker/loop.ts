import {
  DEFAULT_RATING,
  MATCHMAKING_INTERVAL_MS,
  MAX_MATCHES_PER_TICK,
  type MatchDecision,
  findBestMatch,
  isFail,
} from "@suddenqueue/core";

import type { CreatedMatch, MatchLifecycle } from "../match/lifecycle.js";
import type { QueueRepository } from "../queue/repository.js";

export interface MatchmakerEvents {
  onMatchCreated?: (match: CreatedMatch, region: string) => void | Promise<void>;
  onTicketsPruned?: (partyIds: string[]) => void | Promise<void>;
  onError?: (error: unknown, context: string) => void;
}

/**
 * The matchmaking loop — ported from the earlier matchmaking service.
 *
 * Runs on a timer and can also be poked on demand when someone joins the
 * queue. Each pass scans every active region, scores the best candidate, and
 * commits it.
 *
 * The rerun-coalescing from the earlier version is kept: a queue-join arriving
 * mid-pass sets a flag rather than starting a second concurrent pass, so bursts
 * of joins collapse into one extra sweep instead of stacking.
 *
 * What is gone is the cross-server reservation dance. One process owns the
 * matchmaker, so committing a decision is a single transaction rather than a
 * two-phase claim with rollback.
 */
export class Matchmaker {
  private running = false;
  private inPass = false;
  private rerunRequested = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queue: QueueRepository,
    private readonly lifecycle: MatchLifecycle,
    private readonly events: MatchmakerEvents = {},
    private readonly intervalMs: number = MATCHMAKING_INTERVAL_MS,
  ) {}

  /**
   * One full pass over every active region.
   *
   * Parties committed earlier in the pass are held back from later regions:
   * a party queued for NA and EU could otherwise be scored into two matches
   * before either commit lands. The commit would reject the second anyway, but
   * skipping it avoids burning a candidate slot on work that must fail.
   */
  async runPass(): Promise<number> {
    let created = 0;

    try {
      const pruned = await this.queue.pruneStale();
      if (pruned.length > 0) await this.events.onTicketsPruned?.(pruned);
    } catch (err) {
      this.events.onError?.(err, "pruneStale");
    }

    let regions: string[];
    try {
      regions = await this.queue.activeRegions();
    } catch (err) {
      this.events.onError?.(err, "activeRegions");
      return 0;
    }

    const claimed = new Set<string>();

    for (const region of regions) {
      while (created < MAX_MATCHES_PER_TICK) {
        let decision: MatchDecision | null;

        try {
          const pool = (await this.queue.poolForRegion(region)).filter(
            (t) => !claimed.has(t.partyId),
          );
          decision = findBestMatch(pool, Math.floor(Date.now() / 1000), DEFAULT_RATING);
        } catch (err) {
          this.events.onError?.(err, `poolForRegion(${region})`);
          break;
        }

        if (!decision) break;

        const partyIds = [...decision.team1PartyIds, ...decision.team2PartyIds];

        try {
          const result = await this.lifecycle.createFromDecision(decision, region);

          if (isFail(result)) {
            // Lost a race — the tickets moved under us. Hold these parties back
            // so the next iteration scores a different candidate instead of
            // looping on the same doomed one.
            for (const id of partyIds) claimed.add(id);
            continue;
          }

          for (const id of partyIds) claimed.add(id);
          created += 1;
          await this.events.onMatchCreated?.(result.data, region);
        } catch (err) {
          this.events.onError?.(err, "createFromDecision");
          for (const id of partyIds) claimed.add(id);
        }
      }

      if (created >= MAX_MATCHES_PER_TICK) break;
    }

    return created;
  }

  /**
   * Requests a pass. If one is already running, flags a rerun so the current
   * pass loops again rather than starting a concurrent one.
   */
  requestRun(): void {
    if (!this.running) return;

    if (this.inPass) {
      this.rerunRequested = true;
      return;
    }

    void this.drain();
  }

  private async drain(): Promise<void> {
    do {
      this.inPass = true;
      this.rerunRequested = false;

      try {
        await this.runPass();
      } catch (err) {
        this.events.onError?.(err, "runPass");
      }

      this.inPass = false;
    } while (this.rerunRequested && this.running);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.requestRun(), this.intervalMs);
    // Do not wait a full interval before the first sweep.
    this.requestRun();
  }

  stop(): void {
    this.running = false;
    this.rerunRequested = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}

/**
 * Expiry sweeper. Separate from the matchmaker because it must keep running
 * even when the queue is empty — the matches it rescues are already out of it.
 */
export class MatchSweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly lifecycle: MatchLifecycle,
    private readonly events: {
      onCancelled?: (
        matchId: string,
        missed: string[],
        kept: string[],
        /** What the miss cost each person at fault. */
        penalties: { userId: string; cooldownSeconds: number }[],
      ) => void | Promise<void>;
      onLive?: (matchId: string) => void | Promise<void>;
      onDisputed?: (matchId: string) => void | Promise<void>;
      onError?: (error: unknown) => void;
    } = {},
    private readonly intervalMs = 1_000,
  ) {}

  async sweepOnce(): Promise<void> {
    try {
      const result = await this.lifecycle.sweepExpired();

      for (const c of result.cancelled) {
        await this.events.onCancelled?.(c.matchId, c.missedUserIds, c.keptUserIds, c.penalties);
      }
      for (const id of result.startedLive) await this.events.onLive?.(id);
      for (const id of result.disputed) await this.events.onDisputed?.(id);
    } catch (err) {
      this.events.onError?.(err);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweepOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
