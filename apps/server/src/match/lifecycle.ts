import {
  ACCEPT_WINDOW_SECONDS,
  DEFAULT_RATING,
  MATCH_SIZE,
  TEAM_SIZE,
  type MatchDecision,
  PARTY_UP_SECONDS,
  REPORT_WINDOW_SECONDS,
  type Result,
  fail,
  isPlaced,
  missedAcceptPenalty,
  ok,
  placementGamesRemaining,
  tierForRating,
} from "@suddenqueue/core";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { isGameMaster } from "../auth/roles.js";
import type { Database, Executor } from "../db/client.js";
import {
  matchParticipants,
  matches,
  parties,
  partyMembers,
  playerRatings,
  queueTickets,
  users,
} from "../db/schema/index.js";

export interface MatchViewPlayer {
  id: string;
  discordName: string;
  inGameName: string;
  avatarUrl: string | null;
  /** Shown as a GM prefix wherever this name appears. */
  isGameMaster: boolean;
  /** Rank only. The number behind it is deliberately not published. */
  tier: string | null;
  placementsRemaining: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  accepted: boolean;
}

export interface MatchView {
  id: string;
  type: "PUG" | "SCRIM";
  region: string;
  state: string;
  result: "TEAM1" | "TEAM2" | null;
  acceptDeadline: string | null;
  partyUpDeadline: string | null;
  reportDeadline: string | null;
  createdAt: string;
  /** Team strength as a rank, for the same reason as the players'. */
  team1Tier: string;
  team2Tier: string;
  captain1: string | null;
  captain2: string | null;
  team1: MatchViewPlayer[];
  team2: MatchViewPlayer[];
}

/** A committed scrim. No party ids: the ten players were named outright. */
export interface CreatedScrim {
  matchId: string;
  userIds: string[];
  acceptDeadline: Date;
}

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

      const team1Users = decision.team1PartyIds.flatMap((p) => membersByParty.get(p)?.members ?? []);
      const team2Users = decision.team2PartyIds.flatMap((p) => membersByParty.get(p)?.members ?? []);
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
   *
   * Uses parties.leaderId rather than "first member". Members inserted in one
   * statement share an identical joined_at (Postgres now() is transaction
   * scoped), so ordering by it breaks ties arbitrarily and would pick a
   * different captain run to run. Party size ties break on party id for the
   * same reason.
   */
  private pickCaptain(
    partyIds: string[],
    parties: Map<string, { leaderId: string; members: string[] }>,
  ): string | null {
    let bestId: string | null = null;
    let bestSize = -1;

    for (const id of [...partyIds].sort()) {
      const p = parties.get(id);
      if (!p || p.members.length === 0) continue;
      if (p.members.length > bestSize) {
        bestSize = p.members.length;
        bestId = id;
      }
    }

    return bestId === null ? null : (parties.get(bestId)?.leaderId ?? null);
  }

  /**
   * Party membership plus each party's leader.
   *
   * Uses the query builder rather than a raw ANY(): Drizzle spreads a JS array
   * into individual placeholders, which Postgres reads as a row constructor
   * and rejects. Ordering includes userId so member order is stable even when
   * rows share a joined_at.
   */
  private async membersOf(
    tx: Executor,
    partyIds: string[],
  ): Promise<Map<string, { leaderId: string; members: string[] }>> {
    if (partyIds.length === 0) return new Map();

    const rows = await tx
      .select({
        partyId: partyMembers.partyId,
        userId: partyMembers.userId,
        leaderId: parties.leaderId,
      })
      .from(partyMembers)
      .innerJoin(parties, eq(parties.id, partyMembers.partyId))
      .where(inArray(partyMembers.partyId, partyIds))
      .orderBy(partyMembers.joinedAt, partyMembers.userId);

    const out = new Map<string, { leaderId: string; members: string[] }>();
    for (const r of rows) {
      const entry = out.get(r.partyId);
      if (entry) entry.members.push(r.userId);
      else out.set(r.partyId, { leaderId: r.leaderId, members: [r.userId] });
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
  /**
   * A declined match is cancelled for all ten, so it carries the same cooldown
   * as letting the clock run out.
   *
   * Declining is the more considerate of the two -- it frees the other nine in
   * seconds rather than making them wait out the timer -- but the harm to them
   * is the same, and pricing it lower would just make dodging cheaper.
   */
  async decline(
    matchId: string,
    userId: string,
  ): Promise<Result<{ cancelled: boolean; cooldownSeconds: number }, "NOT_PENDING">> {
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

      const [penalty] = await this.penaliseMissedAccepts([userId], new Date());
      return ok({ cancelled: true, cooldownSeconds: penalty?.cooldownSeconds ?? 0 });
    });
  }

  /**
   * Expires overdue matches. Without this a single player closing the app
   * freezes nine others out of the queue indefinitely.
   *
   * Returns what it touched so the caller can notify and requeue.
   */
  async sweepExpired(): Promise<{
    cancelled: {
      matchId: string;
      missedUserIds: string[];
      keptUserIds: string[];
      /** What the miss cost each person at fault, so they can be told. */
      penalties: { userId: string; cooldownSeconds: number }[];
    }[];
    startedLive: string[];
    disputed: string[];
  }> {
    const now = new Date();

    const cancelled: {
      matchId: string;
      missedUserIds: string[];
      keptUserIds: string[];
      penalties: { userId: string; cooldownSeconds: number }[];
    }[] = [];

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

      const penalties = await this.penaliseMissedAccepts(missed, now);
      cancelled.push({ matchId: m.id, missedUserIds: missed, keptUserIds: kept, penalties });
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

  /**
   * Commits a scrim between two rosters.
   *
   * The PUG path above starts from queue tickets and has to defend against them
   * vanishing mid-commit. A scrim has no tickets: two captains agreed, and the
   * ten players are named outright. What it still has to defend against is the
   * same people being somewhere else -- in another match, or sitting in the PUG
   * queue -- because a scrim that quietly pulls someone out of a queue they are
   * waiting in is worse than one that refuses to start.
   */
  async createScrim(input: {
    region: string;
    team1Id: string;
    team2Id: string;
    team1UserIds: string[];
    team2UserIds: string[];
    captain1: string;
    captain2: string;
    team1Rating: number;
    team2Rating: number;
  }): Promise<Result<CreatedScrim, "WRONG_SIZE" | "PLAYER_BUSY" | "PLAYER_QUEUED">> {
    const allUsers = [...input.team1UserIds, ...input.team2UserIds];

    if (
      input.team1UserIds.length !== TEAM_SIZE ||
      input.team2UserIds.length !== TEAM_SIZE ||
      new Set(allUsers).size !== MATCH_SIZE
    ) {
      return fail("WRONG_SIZE", `A scrim needs ${TEAM_SIZE} players a side`);
    }

    return this.db.transaction(async (tx) => {
      const busy = await tx
        .select({ userId: matchParticipants.userId })
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
        return fail("PLAYER_BUSY", "Someone on one of these rosters is already in a match");
      }

      const queued = await tx
        .select({ userId: partyMembers.userId })
        .from(partyMembers)
        .innerJoin(queueTickets, eq(queueTickets.partyId, partyMembers.partyId))
        .where(inArray(partyMembers.userId, allUsers))
        .limit(1);

      if (queued.length > 0) {
        return fail("PLAYER_QUEUED", "Someone on one of these rosters is in the queue");
      }

      const now = new Date();
      const acceptDeadline = new Date(now.getTime() + ACCEPT_WINDOW_SECONDS * 1000);

      const [match] = await tx
        .insert(matches)
        .values({
          type: "SCRIM",
          region: input.region,
          state: "PENDING_ACCEPT",
          // Frozen for the record, not for rating: settle() gives a scrim a
          // zero delta whatever these say.
          team1Rating: input.team1Rating,
          team2Rating: input.team2Rating,
          team1Id: input.team1Id,
          team2Id: input.team2Id,
          acceptDeadline,
        })
        .returning({ id: matches.id });

      await tx.insert(matchParticipants).values([
        ...input.team1UserIds.map((userId) => ({
          matchId: match!.id,
          userId,
          team: 1,
          isCaptain: userId === input.captain1,
        })),
        ...input.team2UserIds.map((userId) => ({
          matchId: match!.id,
          userId,
          team: 2,
          isCaptain: userId === input.captain2,
        })),
      ]);

      return ok({ matchId: match!.id, userIds: allUsers, acceptDeadline });
    });
  }

  /**
   * The match as a client can render it.
   *
   * Participant rows carry user ids and nothing else, which is enough to decide
   * who to notify but not enough to draw a roster: name, rating and tier all
   * live on other tables. Joining them here keeps that join in one place rather
   * than leaving every caller to re-derive a roster, and means the push event
   * and the fetch hand back the identical shape.
   */
  async view(matchId: string): Promise<MatchView | null> {
    const match = await this.getMatch(matchId);
    if (!match) return null;

    const rows = await this.db
      .select({
        userId: matchParticipants.userId,
        team: matchParticipants.team,
        isCaptain: matchParticipants.isCaptain,
        acceptedAt: matchParticipants.acceptedAt,
        discordName: users.discordName,
        inGameName: users.inGameName,
        avatarUrl: users.avatarUrl,
        role: users.role,
        rating: playerRatings.rating,
        peakRating: playerRatings.peakRating,
        gamesPlayed: playerRatings.gamesPlayed,
        wins: playerRatings.wins,
        losses: playerRatings.losses,
      })
      .from(matchParticipants)
      .innerJoin(users, eq(users.id, matchParticipants.userId))
      .leftJoin(playerRatings, eq(playerRatings.userId, matchParticipants.userId))
      .where(eq(matchParticipants.matchId, matchId))
      .orderBy(matchParticipants.team);

    const toPlayer = (r: (typeof rows)[number]): MatchViewPlayer => {
      const rating = r.rating ?? DEFAULT_RATING;
      const gamesPlayed = r.gamesPlayed ?? 0;
      return {
        id: r.userId,
        discordName: r.discordName,
        // The in-game name is optional until a player sets it, and the roster is
        // exactly where a blank would hurt -- it is the name teammates type to
        // find each other in-game -- so fall back to something addressable.
        inGameName: r.inGameName ?? r.discordName,
        avatarUrl: r.avatarUrl,
        isGameMaster: isGameMaster(r.role),
        // Same rule as /me: no rank until placements are done.
        tier: isPlaced(gamesPlayed) ? tierForRating(rating) : null,
        placementsRemaining: placementGamesRemaining(gamesPlayed),
        gamesPlayed,
        wins: r.wins ?? 0,
        losses: r.losses ?? 0,
        accepted: r.acceptedAt !== null,
      };
    };

    return {
      id: match.id,
      type: match.type,
      region: match.region,
      state: match.state,
      result: match.result,
      acceptDeadline: match.acceptDeadline?.toISOString() ?? null,
      partyUpDeadline: match.partyUpDeadline?.toISOString() ?? null,
      reportDeadline: match.reportDeadline?.toISOString() ?? null,
      createdAt: match.createdAt.toISOString(),
      // Derived from the averages frozen at creation, so the two sides read as
      // comparable strengths without either number leaving the server.
      team1Tier: tierForRating(match.team1Rating),
      team2Tier: tierForRating(match.team2Rating),
      captain1: rows.find((r) => r.team === 1 && r.isCaptain)?.userId ?? null,
      captain2: rows.find((r) => r.team === 2 && r.isCaptain)?.userId ?? null,
      team1: rows.filter((r) => r.team === 1).map(toPlayer),
      team2: rows.filter((r) => r.team === 2).map(toPlayer),
    };
  }

  /**
   * How many players are currently inside a match.
   *
   * Anything before COMPLETED counts: a player sitting on an accept prompt is
   * as unavailable as one who is mid-game.
   */
  async countPlayersInMatches(): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(matchParticipants)
      .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
      .where(inArray(matches.state, ["PENDING_ACCEPT", "PARTY_UP", "LIVE", "REPORTED"]));

    return row?.total ?? 0;
  }

  /**
   * Charges a queue cooldown to everyone who let the accept lapse.
   *
   * A missed accept costs nine other people their match, so it has to cost the
   * person who missed it something, or the cheapest way to pick your matches is
   * to sit on the prompt. The schedule escalates within a session and forgets
   * after a clean day -- see missedAcceptPenalty.
   */
  private async penaliseMissedAccepts(
    userIds: string[],
    now: Date,
  ): Promise<{ userId: string; cooldownSeconds: number }[]> {
    if (userIds.length === 0) return [];

    const rows = await this.db
      .select({
        userId: playerRatings.userId,
        recent: playerRatings.recentMissedAccepts,
        lastAt: playerRatings.lastMissedAcceptAt,
      })
      .from(playerRatings)
      .where(inArray(playerRatings.userId, userIds));

    const known = new Map(rows.map((r) => [r.userId, r]));
    const applied: { userId: string; cooldownSeconds: number }[] = [];

    for (const userId of userIds) {
      const state = known.get(userId);
      const penalty = missedAcceptPenalty(
        { recent: state?.recent ?? 0, lastAt: state?.lastAt ?? null },
        now,
      );

      await this.db
        .update(playerRatings)
        .set({
          // The lifetime counter is for the profile; the recent one drives the
          // schedule and is reset by missedAcceptPenalty when it has decayed.
          missedAccepts: sql`${playerRatings.missedAccepts} + 1`,
          recentMissedAccepts: penalty.offence,
          lastMissedAcceptAt: now,
          queueCooldownUntil: penalty.cooldownUntil,
          updatedAt: now,
        })
        .where(eq(playerRatings.userId, userId));

      applied.push({ userId, cooldownSeconds: penalty.cooldownSeconds });
    }

    return applied;
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
