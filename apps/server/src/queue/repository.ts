import { QUEUE_STALE_AFTER_SECONDS, type QueueTicket } from "@suddenqueue/core";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

import type { Database, Executor } from "../db/client.js";
import { partyMembers, queueTickets } from "../db/schema/index.js";

/**
 * Queue ticket persistence.
 *
 * The earlier equivalent needed MMR bucketing, a separate ordering index,
 * cross-server heartbeats, and a self-healing consistency check between two
 * in-memory maps — all to make a *distributed* queue scannable. A single
 * matchmaker process reading Postgres needs none of that.
 *
 * The heartbeat survives, repurposed: it is now WebSocket liveness. A ticket
 * whose client has gone quiet expires exactly as a stale ticket did, or
 * the queue fills with players who closed the app.
 */
export class QueueRepository {
  constructor(private readonly db: Database) {}

  /**
   * Joins the queue. Returns the created ticket, or null if the party already
   * holds one — the unique index on party_id makes that a database guarantee
   * rather than a check-then-insert race.
   */
  async join(params: {
    partyId: string;
    regions: string[];
    ratingSnapshot: number;
    size: number;
  }): Promise<{ id: string } | null> {
    const rows = await this.db
      .insert(queueTickets)
      .values({
        partyId: params.partyId,
        regions: params.regions,
        ratingSnapshot: params.ratingSnapshot,
        size: params.size,
      })
      .onConflictDoNothing({ target: queueTickets.partyId })
      .returning({ id: queueTickets.id });

    return rows[0] ?? null;
  }

  async leave(partyId: string): Promise<boolean> {
    const rows = await this.db
      .delete(queueTickets)
      .where(eq(queueTickets.partyId, partyId))
      .returning({ id: queueTickets.id });

    return rows.length > 0;
  }

  /** Extends a ticket's life. Called on the client's WebSocket heartbeat. */
  async heartbeat(partyId: string): Promise<boolean> {
    const rows = await this.db
      .update(queueTickets)
      .set({ heartbeatAt: new Date() })
      .where(eq(queueTickets.partyId, partyId))
      .returning({ id: queueTickets.id });

    return rows.length > 0;
  }

  /**
   * Drops tickets whose client stopped heartbeating. Returns the party ids so
   * the caller can notify anyone still connected.
   */
  async pruneStale(): Promise<string[]> {
    const cutoff = new Date(Date.now() - QUEUE_STALE_AFTER_SECONDS * 1000);
    const rows = await this.db
      .delete(queueTickets)
      .where(lt(queueTickets.heartbeatAt, cutoff))
      .returning({ partyId: queueTickets.partyId });

    return rows.map((r) => r.partyId);
  }

  /**
   * The matchmaking pool for one region, oldest first.
   *
   * Region is matched against the ticket's accepted list, so a party queued for
   * NA+EU appears in both pools and whichever fills first wins.
   */
  async poolForRegion(region: string): Promise<QueueTicket[]> {
    const rows = await this.db
      .select({
        partyId: queueTickets.partyId,
        size: queueTickets.size,
        ratingSnapshot: queueTickets.ratingSnapshot,
        joinedAt: queueTickets.joinedAt,
      })
      .from(queueTickets)
      .where(sql`${region} = ANY(${queueTickets.regions})`)
      .orderBy(queueTickets.joinedAt);

    return rows.map((r) => ({
      partyId: r.partyId,
      size: r.size,
      ratingSnapshot: r.ratingSnapshot,
      joinedAt: Math.floor(r.joinedAt.getTime() / 1000),
    }));
  }

  /** Every distinct region with at least one queued party. */
  async activeRegions(): Promise<string[]> {
    const rows = await this.db
      .select({ region: sql<string>`DISTINCT unnest(${queueTickets.regions})` })
      .from(queueTickets);

    return rows.map((r) => r.region);
  }

  async countQueuedPlayers(): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${queueTickets.size}), 0)::int` })
      .from(queueTickets);

    return rows[0]?.total ?? 0;
  }

  async getByPartyId(partyId: string) {
    const rows = await this.db
      .select()
      .from(queueTickets)
      .where(eq(queueTickets.partyId, partyId))
      .limit(1);

    return rows[0] ?? null;
  }

  /** Member user ids for each of the given parties, in party order. */
  async membersOf(partyIds: string[]): Promise<Map<string, string[]>> {
    if (partyIds.length === 0) return new Map();

    const rows = await this.db
      .select({ partyId: partyMembers.partyId, userId: partyMembers.userId })
      .from(partyMembers)
      .where(inArray(partyMembers.partyId, partyIds))
      .orderBy(partyMembers.joinedAt);

    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.partyId);
      if (list) list.push(r.userId);
      else out.set(r.partyId, [r.userId]);
    }
    return out;
  }

  /** Removes tickets for parties that have just been committed to a match. */
  async removeMany(partyIds: string[], tx?: Executor): Promise<void> {
    if (partyIds.length === 0) return;
    const conn = tx ?? this.db;
    await conn.delete(queueTickets).where(inArray(queueTickets.partyId, partyIds));
  }

  /**
   * Locks the given parties' tickets for the duration of the caller's
   * transaction, returning only those that still exist.
   *
   * This is the reservation. The earlier system needed two-phase claims because
   * many lobby servers raced for the same party; one matchmaker process against
   * one database needs only a row lock.
   */
  async lockTickets(tx: Executor, partyIds: string[]) {
    if (partyIds.length === 0) return [];

    return tx
      .select({
        partyId: queueTickets.partyId,
        size: queueTickets.size,
        ratingSnapshot: queueTickets.ratingSnapshot,
        regions: queueTickets.regions,
      })
      .from(queueTickets)
      .where(inArray(queueTickets.partyId, partyIds))
      .for("update");
  }
}
