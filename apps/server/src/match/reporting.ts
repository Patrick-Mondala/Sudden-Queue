import {
  DEFAULT_RATING,
  REPORT_WINDOW_SECONDS,
  type Result,
  applyMatchResult,
  fail,
  isPlaced,
  ok,
  placementGamesRemaining,
  tierForRating,
} from "@suddenqueue/core";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database, Executor } from "../db/client.js";
import {
  disputes,
  matchParticipants,
  matchReports,
  matches,
  playerRatings,
  ratingAdjustments,
  users,
} from "../db/schema/index.js";

export type Winner = "TEAM1" | "TEAM2";

export interface ReportOutcome {
  state: "REPORTED" | "COMPLETED" | "DISPUTED";
  winner: Winner | null;
  /** Present only once a result is agreed and rating has been applied. */
  ratingChanges?: RatingChange[];
}

/**
 * What a resolved match did to one player.
 *
 * Points are carried for the ledger and for reversal arithmetic; the tiers are
 * what a player is ever shown, since rank is the public unit and the number
 * behind it is not published.
 */
export interface RatingChange {
  userId: string;
  before: number;
  delta: number;
  after: number;
  tierBefore: string | null;
  tierAfter: string | null;
  placementsRemaining: number;
}

type ReportError =
  | "MATCH_NOT_FOUND"
  | "NOT_A_CAPTAIN"
  | "NOT_REPORTABLE"
  | "ALREADY_RESOLVED";

/**
 * Result reporting.
 *
 * This is the part with no precedent to port. Where a game server is
 * authoritative, a result is simply true. Here nothing can observe a match,
 * so a result is two captains asserting the same thing — and rating only moves
 * on agreement. A disagreement, or a captain who never reports, goes to a human
 * instead of guessing.
 */
export class MatchReporting {
  constructor(private readonly db: Database) {}

  /**
   * Records one captain's claim.
   *
   * Agreement resolves the match and applies rating. Disagreement opens a
   * dispute and moves nothing, so the common case for an overturned result is
   * "never applied" rather than "applied and reversed".
   */
  async report(
    matchId: string,
    userId: string,
    claimedWinner: Winner,
  ): Promise<Result<ReportOutcome, ReportError>> {
    return this.db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(matches)
        .where(eq(matches.id, matchId))
        .for("update");

      if (!match) return fail("MATCH_NOT_FOUND", "Match not found");

      if (match.state === "COMPLETED" || match.state === "DISPUTED") {
        return fail("ALREADY_RESOLVED", "This match has already been settled");
      }

      if (match.state !== "LIVE" && match.state !== "REPORTED") {
        return fail("NOT_REPORTABLE", "The match is not ready to be reported yet");
      }

      const [reporter] = await tx
        .select({ team: matchParticipants.team, isCaptain: matchParticipants.isCaptain })
        .from(matchParticipants)
        .where(
          and(eq(matchParticipants.matchId, matchId), eq(matchParticipants.userId, userId)),
        );

      if (!reporter || !reporter.isCaptain) {
        return fail("NOT_A_CAPTAIN", "Only a team captain can report the result");
      }

      // Re-reporting replaces the previous claim rather than stacking rows, so
      // a captain who misclicks can correct themselves before the other side
      // reports.
      await tx
        .insert(matchReports)
        .values({
          matchId,
          reporterId: userId,
          reportingTeam: reporter.team,
          claimedWinner,
        })
        .onConflictDoUpdate({
          target: [matchReports.matchId, matchReports.reporterId],
          set: { claimedWinner, createdAt: new Date() },
        });

      const reports = await tx
        .select({
          reporterId: matchReports.reporterId,
          reportingTeam: matchReports.reportingTeam,
          claimedWinner: matchReports.claimedWinner,
        })
        .from(matchReports)
        .where(eq(matchReports.matchId, matchId));

      // One report from each side is what "both captains" means; two from the
      // same captain is still one opinion.
      const teamsReported = new Set(reports.map((r) => r.reportingTeam));
      if (teamsReported.size < 2) {
        await tx
          .update(matches)
          .set({
            state: "REPORTED",
            reportDeadline: new Date(Date.now() + REPORT_WINDOW_SECONDS * 1000),
          })
          .where(eq(matches.id, matchId));

        return ok({ state: "REPORTED" as const, winner: null });
      }

      const claims = new Set(reports.map((r) => r.claimedWinner));

      if (claims.size > 1) {
        await tx
          .update(matches)
          .set({ state: "DISPUTED", reportDeadline: null })
          .where(eq(matches.id, matchId));

        await tx.insert(disputes).values({
          matchId,
          reason: "Captains reported different results",
        });

        await tx
          .update(playerRatings)
          .set({ disputesInvolved: sql`${playerRatings.disputesInvolved} + 1` })
          .where(
            inArray(
              playerRatings.userId,
              tx
                .select({ id: matchParticipants.userId })
                .from(matchParticipants)
                .where(eq(matchParticipants.matchId, matchId)),
            ),
          );

        return ok({ state: "DISPUTED" as const, winner: null });
      }

      const winner = [...claims][0] as Winner;
      const changes = await this.settle(tx, matchId, winner, match.type, {
        team1Rating: match.team1Rating,
        team2Rating: match.team2Rating,
      });

      return ok({ state: "COMPLETED" as const, winner, ratingChanges: changes });
    });
  }

  /**
   * Applies the agreed result: rating deltas, win/loss counters, and the match
   * row. Guarded by ratingApplied so a retry cannot double-apply.
   *
   * Scrims run this same path with a zero delta — they are unrated, but they
   * still record who played and who won.
   */
  private async settle(
    tx: Executor,
    matchId: string,
    winner: Winner,
    type: "PUG" | "SCRIM",
    snapshots: { team1Rating: number; team2Rating: number },
  ): Promise<RatingChange[]> {
    const participants = await tx
      .select({
        userId: matchParticipants.userId,
        team: matchParticipants.team,
        rating: playerRatings.rating,
        gamesPlayed: playerRatings.gamesPlayed,
        peakRating: playerRatings.peakRating,
        currentStreak: playerRatings.currentWinStreak,
        longestStreak: playerRatings.longestWinStreak,
      })
      .from(matchParticipants)
      .leftJoin(playerRatings, eq(playerRatings.userId, matchParticipants.userId))
      .where(eq(matchParticipants.matchId, matchId));

    const changes: RatingChange[] = [];

    for (const p of participants) {
      const won = (p.team === 1 && winner === "TEAM1") || (p.team === 2 && winner === "TEAM2");
      const opponentRating = p.team === 1 ? snapshots.team2Rating : snapshots.team1Rating;

      // Rating uses the player's CURRENT value, not the queue snapshot: time
      // may have passed and other matches may have resolved since.
      const before = p.rating ?? DEFAULT_RATING;
      const gamesPlayed = p.gamesPlayed ?? 0;

      const applied =
        type === "SCRIM"
          ? { ratingBefore: before, ratingDelta: 0, ratingAfter: before }
          : applyMatchResult({
              playerRating: before,
              gamesPlayed,
              opponentTeamRating: opponentRating,
              won,
            });

      // Recording both halves is what makes a Game Master's reversal exact
      // arithmetic rather than a recomputation against ratings that have moved.
      await tx
        .update(matchParticipants)
        .set({ ratingBefore: applied.ratingBefore, ratingDelta: applied.ratingDelta })
        .where(
          and(
            eq(matchParticipants.matchId, matchId),
            eq(matchParticipants.userId, p.userId),
          ),
        );

      const streak = won ? (p.currentStreak ?? 0) + 1 : 0;

      await tx
        .update(playerRatings)
        .set({
          rating: applied.ratingAfter,
          peakRating: Math.max(p.peakRating ?? applied.ratingAfter, applied.ratingAfter),
          gamesPlayed: gamesPlayed + 1,
          wins: won ? sql`${playerRatings.wins} + 1` : playerRatings.wins,
          losses: won ? playerRatings.losses : sql`${playerRatings.losses} + 1`,
          currentWinStreak: streak,
          longestWinStreak: Math.max(p.longestStreak ?? 0, streak),
          updatedAt: new Date(),
        })
        .where(eq(playerRatings.userId, p.userId));

      // This match is the one that just counted, so the "after" side is judged
      // on the incremented total: the fifth game is what ends placements and
      // reveals a rank for the first time.
      const gamesAfter = gamesPlayed + 1;

      changes.push({
        userId: p.userId,
        before: applied.ratingBefore,
        delta: applied.ratingDelta,
        after: applied.ratingAfter,
        tierBefore: isPlaced(gamesPlayed) ? tierForRating(applied.ratingBefore) : null,
        tierAfter: isPlaced(gamesAfter) ? tierForRating(applied.ratingAfter) : null,
        placementsRemaining: placementGamesRemaining(gamesAfter),
      });
    }

    await tx
      .update(matches)
      .set({
        state: "COMPLETED",
        result: winner,
        ratingApplied: type !== "SCRIM",
        reportDeadline: null,
        resolvedAt: new Date(),
      })
      .where(eq(matches.id, matchId));

    return changes;
  }

  /**
   * A Game Master settles a dispute.
   *
   * If rating was never applied — the usual case, since disagreement blocks it
   * — this simply applies the ruled result. If it somehow was, the previously
   * applied deltas are inverted through the adjustments ledger first, so the
   * correction is exact and stays explainable.
   */
  async resolveDispute(
    matchId: string,
    gameMasterId: string,
    ruling: Winner,
    note: string,
  ): Promise<Result<ReportOutcome, "MATCH_NOT_FOUND" | "NOT_DISPUTED">> {
    return this.db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(matches)
        .where(eq(matches.id, matchId))
        .for("update");

      if (!match) return fail("MATCH_NOT_FOUND", "Match not found");
      if (match.state !== "DISPUTED") {
        return fail("NOT_DISPUTED", "That match is not in dispute");
      }

      if (match.ratingApplied) {
        await this.reverseApplied(tx, matchId, gameMasterId, "Dispute resolution");
      }

      const changes = await this.settle(tx, matchId, ruling, match.type, {
        team1Rating: match.team1Rating,
        team2Rating: match.team2Rating,
      });

      await tx
        .update(disputes)
        .set({
          status: "resolved",
          resolvedBy: gameMasterId,
          resolutionNote: note,
          resolvedAt: new Date(),
        })
        .where(and(eq(disputes.matchId, matchId), eq(disputes.status, "open")));

      return ok({ state: "COMPLETED" as const, winner: ruling, ratingChanges: changes });
    });
  }

  /** Writes inverse deltas for every participant and rewinds their rating. */
  private async reverseApplied(
    tx: Executor,
    matchId: string,
    gameMasterId: string,
    reason: string,
  ): Promise<void> {
    const applied = await tx
      .select({
        userId: matchParticipants.userId,
        delta: matchParticipants.ratingDelta,
      })
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, matchId));

    for (const row of applied) {
      if (row.delta === null || row.delta === 0) continue;

      await tx.insert(ratingAdjustments).values({
        userId: row.userId,
        matchId,
        delta: -row.delta,
        reason,
        appliedBy: gameMasterId,
      });

      await tx
        .update(playerRatings)
        .set({
          rating: sql`${playerRatings.rating} - ${row.delta}`,
          gamesPlayed: sql`GREATEST(${playerRatings.gamesPlayed} - 1, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(playerRatings.userId, row.userId));
    }
  }

  async reportsFor(matchId: string) {
    return this.db.select().from(matchReports).where(eq(matchReports.matchId, matchId));
  }

  /**
   * Open disputes, with enough to rule on.
   *
   * A list of ids is not a queue anyone can work: what a Game Master needs is
   * the two claims side by side and who made them. Rosters are not included --
   * they come from the match route, which a Game Master may already read.
   */
  async openDisputes() {
    const rows = await this.db
      .select({
        disputeId: disputes.id,
        matchId: disputes.matchId,
        reason: disputes.reason,
        openedAt: disputes.openedAt,
        type: matches.type,
        region: matches.region,
        playedAt: matches.createdAt,
      })
      .from(disputes)
      .innerJoin(matches, eq(matches.id, disputes.matchId))
      .where(eq(disputes.status, "open"))
      .orderBy(disputes.openedAt);

    if (rows.length === 0) return [];

    const claims = await this.db
      .select({
        matchId: matchReports.matchId,
        reporterId: matchReports.reporterId,
        discordName: users.discordName,
        inGameName: users.inGameName,
        reportingTeam: matchReports.reportingTeam,
        claimedWinner: matchReports.claimedWinner,
      })
      .from(matchReports)
      .innerJoin(users, eq(users.id, matchReports.reporterId))
      .where(
        inArray(
          matchReports.matchId,
          rows.map((r) => r.matchId),
        ),
      )
      .orderBy(matchReports.reportingTeam);

    return rows.map((r) => ({
      disputeId: r.disputeId,
      matchId: r.matchId,
      reason: r.reason,
      openedAt: r.openedAt.toISOString(),
      type: r.type,
      region: r.region,
      playedAt: r.playedAt.toISOString(),
      reports: claims
        .filter((c) => c.matchId === r.matchId)
        .map((c) => ({
          reporterId: c.reporterId,
          discordName: c.discordName,
          inGameName: c.inGameName,
          reportingTeam: c.reportingTeam,
          claimedWinner: c.claimedWinner,
        })),
    }));
  }

  /** A player's finished matches, newest first. */
  async historyFor(userId: string, limit = 25) {
    return this.db
      .select({
        matchId: matches.id,
        type: matches.type,
        region: matches.region,
        state: matches.state,
        result: matches.result,
        team: matchParticipants.team,
        // No delta: a history of point swings reconstructs the rating the rank
        // is meant to stand in for.
        resolvedAt: matches.resolvedAt,
        createdAt: matches.createdAt,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
      .where(
        and(
          eq(matchParticipants.userId, userId),
          inArray(matches.state, ["COMPLETED", "DISPUTED"]),
        ),
      )
      .orderBy(sql`${matches.createdAt} DESC`)
      .limit(limit);
  }
}
