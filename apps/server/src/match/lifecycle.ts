import {
  ACCEPT_WINDOW_SECONDS,
  DEFAULT_RATING,
  MATCH_SIZE,
  type MatchDecision,
  PARTY_UP_SECONDS,
  REPORT_WINDOW_SECONDS,
  type Result,
  fail,
  ok,
} from "@suddenqueue/core";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import type { Database, Executor } from "../db/client.js";
import {
  matchParticipants,
  matches,
  partyMembers,
  playerRatings,
  queueTickets,
} from "../db/schema/index.js";

export interface CreatedMatch {
  matchId: string;
  team1PartyIds: string[];
  team2PartyIds: string[];
  userIds: string[];
  acceptDeadline: Date;
}

/**
 * Match lifecycle: creation through accept, party-up, and expiry.
 *
 * The `matches` row IS the reservation. A party whose match sits in
 * PENDING_ACCEPT is committed and no longer in the queue, which is what the
 * earlier reservation store achieved with two-phase claims and claim tokens
 * across many lobby servers.
 */
export class MatchLifecycle {
  constructor(private readonly db: Database) {}

  /**
   * Commits a match decision.
   *
   * Runs as one transaction that locks the tickets, re-verifies they still
   * exist, writes the match and its participants, then deletes the tickets.
   * Re-verification matters because a party can leave the queue between the
   * matchmaker scoring a candidate and this commit.
   */
  async createFromDecision(
    decision: MatchDecision,
    region: string,
    type: "PUG" | "SCRIM" = "PUG",
  ): Promise<Result<CreatedMatch, "TICKET_DISAPPEARED" | "PARTY_ALREADY_MATCHED" | "EMPTY_PARTY">> {
    const allPartyIds = [...decision.team1PartyIds, ...decision.team2PartyIds];

    return this.db.transaction(async (tx) => {
      // Lock first: anything trying to leave the queue now waits on us.
      const locked = await tx
        .select({ partyId: queueTickets.partyId })
        .from(queueTickets)
        .where(inArray(queueTickets.partyId, allPartyIds))
        .for("update");

      if (locked.length !== allPartyIds.length) {
        return fail(
          "TICKET_DISAPPEARED",
          "A party left the queue before the match could be committed",
        );
      }

      const membersByParty = await this.membersOf(tx, allPartyIds);

      const team1Users = decision.team1PartyIds.flatMap((p) => membersByParty.get(p) ?? []);
      const team2Users = decision.team2PartyIds.flatMap((p) => membersByParty.get(p) ?? []);
      const allUsers = [...team1Users, ...team2Users];

      // A player already inside a live match must never be pulled into a second.
      if (allUsers.length > 0) {
        const busy = await tx
          .select({ matchId: matchParticipants.matchId })
          .from(matchParticipants)
          .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
          .where(
            and(
              inArray(matchParticipants.userId, allUsers),
              inArray(matches.state, ["PENDING_ACCEPT", "PARTY_UP", "LIVE", "REPORTED"]),
            ),
          )
          .limit(1);

        if (busy.length > 0) {
          return fail("PARTY_ALREADY_MATCHED", "A party is already committed to another match");
        }
      }

      if (team1Users.length + team2Users.length !== MATCH_SIZE) {
        return fail("EMPTY_PARTY", "Party membership did not add up to a full match");
      }

      const now = new Date();
      const acceptDeadline = new Date(now.getTime() + ACCEPT_WINDOW_SECONDS * 1000);

      const [match] = await tx
        .insert(matches)
        .values({
          type,
          region,
          state: "PENDING_ACCEPT",
          team1Rating: decision.team1Rating,
          team2Rating: decision.team2Rating,
          acceptDeadline,
        })
        .returning({ id: matches.id });

      const captain1 = this.pickCaptain(decision.team1PartyIds, membersByParty);
      const captain2 = this.pickCaptain(decision.team2PartyIds, membersByParty);

      await tx.insert(matchParticipants).values([
        ...team1Users.map((userId) => ({
          matchId: match!.id,
          userId,
          team: 1,
          isCaptain: userId === captain1,
        })),
        ...team2Users.map((userId) => ({
          matchId: match!.id,
          userId,
          team: 2,
          isCaptain: userId === captain2,
        })),
      ]);

      // Committed to a match, so out of the queue.
      await tx.delete(queueTickets).where(inArray(queueTickets.partyId, allPartyIds));

      return ok({
        matchId: match!.id,
        team1PartyIds: decision.team1PartyIds,
        team2PartyIds: decision.team2PartyIds,
        userIds: [...team1Users, ...team2Users],
        acceptDeadline,
      });
    });
  }

  /**
   * Captain is the leader of the largest party on the side — the biggest
   * premade is already coordinating, so it is the least disruptive choice.
   */
  private pickCaptain(partyIds: string[], members: Map<string, string[]>): string | null {
    let best: string[] | null = null;
    for (const id of partyIds) {
      const m = members.get(id);
      if (!m || m.length === 0) continue;
      if (best === null || m.length > best.length) best = m;
    }
    return best?.[0] ?? null;
  }

  private async membersOf(tx: Executor, partyIds: string[]): Promise<Map<string, string[]>> {
    if (partyIds.length === 0) return new Map();

    // Uses the query builder rather than a raw ANY(): Drizzle spreads a JS
    // array into individual placeholders, which Postgres reads as a row
    // constructor, not an array.
    const rows = await tx
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

  /**
   * Records one player's accept. When the last of the ten accepts, the match
   * advances to PARTY_UP and its party-up deadline starts.
   */
  async accept(
    matchId: string,
    userId: string,
  ): Promise<Result<{ allAccepted: boolean; accepted: number }, "NOT_A_PARTICIPANT" | "NOT_PENDING">> {
    return this.db.transaction(async (tx) => {
      const [match] = await tx
        .select({ state: matches.state })
        .from(matches)
        .where(eq(matches.id, matchId))
        .for("update");

      if (!match || match.state !== "PENDING_ACCEPT") {
        return fail("NOT_PENDING", "Match is not awaiting accepts");
      }

      const updated = await tx
        .update(matchParticipants)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(matchParticipants.matchId, matchId),
            eq(matchParticipants.userId, userId),
            isNull(matchParticipants.acceptedAt),
          ),
        )
        .returning({ userId: matchParticipants.userId });

      if (updated.length === 0) {
        // Either not in this match, or already accepted. Distinguish the two.
        const [exists] = await tx
          .select({ userId: matchParticipants.userId })
          .from(matchParticipants)
          .where(
            and(eq(matchParticipants.matchId, matchId), eq(matchParticipants.userId, userId)),
          );

        if (!exists) return fail("NOT_A_PARTICIPANT", "Player is not in this match");
      }

      const [counts] = await tx
        .select({
          total: sql<number>`COUNT(*)::int`,
          accepted: sql<number>`COUNT(${matchParticipants.acceptedAt})::int`,
        })
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, matchId));

      const allAccepted = (counts?.accepted ?? 0) === (counts?.total ?? -1);

      if (allAccepted) {
        await tx
          .update(matches)
          .set({
            state: "PARTY_UP",
            acceptDeadline: null,
            partyUpDeadline: new Date(Date.now() + PARTY_UP_SECONDS * 1000),
          })
          .where(eq(matches.id, matchId));
      }

      return ok({ allAccepted, accepted: counts?.accepted ?? 0 });
    });
  }

  /**
   * A decline kills the match immediately rather than waiting out the timer —
   * there is no point making nine people watch a countdown that cannot succeed.
   */
  async decline(
    matchId: string,
    userId: string,
  ): Promise<Result<{ cancelled: boolean }, "NOT_PENDING">> {
    return this.db.transaction(async (tx) => {
      const [match] = await tx
        .select({ state: matches.state })
        .from(matches)
        .where(eq(matches.id, matchId))
        .for("update");

      if (!match || match.state !== "PENDING_ACCEPT") {
        return fail("NOT_PENDING", "Match is not awaiting accepts");
      }

      await tx
        .update(matchParticipants)
        .set({ declinedAt: new Date() })
        .where(
          and(eq(matchParticipants.matchId, matchId), eq(matchParticipants.userId, userId)),
        );

      await tx
        .update(matches)
        .set({
          state: "CANCELLED",
          acceptDeadline: null,
          cancelReason: "DECLINED",
          resolvedAt: new Date(),
        })
        .where(eq(matches.id, matchId));

      return ok({ cancelled: true });
    });
  }

  /**
   * Expires overdue matches. Without this a single player closing the app
   * freezes nine others out of the queue indefinitely.
   *
   * Returns what it touched so the caller can notify and requeue.
   */
  async sweepExpired(): Promise<{
    cancelled: { matchId: string; missedUserIds: string[]; keptUserIds: string[] }[];
    startedLive: string[];
    disputed: string[];
  }> {
    const now = new Date();

    const cancelled: { matchId: string; missedUserIds: string[]; keptUserIds: string[] }[] = [];

    // 1. Accept window blown: cancel, and separate who is at fault.
    const staleAccepts = await this.db
      .select({ id: matches.id })
      .from(matches)
      .where(and(eq(matches.state, "PENDING_ACCEPT"), lt(matches.acceptDeadline, now)));

    for (const m of staleAccepts) {
      const parts = await this.db
        .select({
          userId: matchParticipants.userId,
          acceptedAt: matchParticipants.acceptedAt,
        })
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, m.id));

      const missed = parts.filter((p) => p.acceptedAt === null).map((p) => p.userId);
      const kept = parts.filter((p) => p.acceptedAt !== null).map((p) => p.userId);

      await this.db
        .update(matches)
        .set({
          state: "CANCELLED",
          acceptDeadline: null,
          cancelReason: "ACCEPT_TIMEOUT",
          resolvedAt: now,
        })
        .where(eq(matches.id, m.id));

      cancelled.push({ matchId: m.id, missedUserIds: missed, keptUserIds: kept });
    }

    // 2. Party-up window elapsed: the match is considered under way.
    const started = await this.db
      .update(matches)
      .set({
        state: "LIVE",
        partyUpDeadline: null,
        reportDeadline: new Date(now.getTime() + REPORT_WINDOW_SECONDS * 1000),
      })
      .where(and(eq(matches.state, "PARTY_UP"), lt(matches.partyUpDeadline, now)))
      .returning({ id: matches.id });

    // 3. One captain reported and the other never did: a human decides.
    const disputed = await this.db
      .update(matches)
      .set({ state: "DISPUTED", reportDeadline: null })
      .where(and(eq(matches.state, "REPORTED"), lt(matches.reportDeadline, now)))
      .returning({ id: matches.id });

    return {
      cancelled,
      startedLive: started.map((m) => m.id),
      disputed: disputed.map((m) => m.id),
    };
  }

  async getMatch(matchId: string) {
    const [row] = await this.db.select().from(matches).where(eq(matches.id, matchId));
    return row ?? null;
  }

  async participants(matchId: string) {
    return this.db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, matchId))
      .orderBy(matchParticipants.team);
  }

  /** Rating snapshot for a set of users, defaulting anyone unseen. */
  async ratingsFor(userIds: string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();

    const rows = await this.db
      .select({ userId: playerRatings.userId, rating: playerRatings.rating })
      .from(playerRatings)
      .where(inArray(playerRatings.userId, userIds));

    const out = new Map<string, number>();
    for (const id of userIds) out.set(id, DEFAULT_RATING);
    for (const r of rows) out.set(r.userId, r.rating);
    return out;
  }
}
