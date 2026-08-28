import {
  DEFAULT_RATING,
  PLACEMENT_GAMES,
  isPlaced,
  placementGamesRemaining,
  tierForRating,
} from "@suddenqueue/core";
import { desc, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { playerRatings, teamMembers, teams, users } from "../db/schema/index.js";

export interface LadderRow {
  position: number;
  userId: string;
  discordName: string;
  inGameName: string | null;
  tier: string;
  wins: number;
  losses: number;
  gamesPlayed: number;
  /** The team they play for, when they have one. */
  teamTag: string | null;
}

export interface PublicProfile {
  userId: string;
  discordName: string;
  inGameName: string | null;
  /** Null while they are still in placements. */
  tier: string | null;
  peakTier: string | null;
  placementsRemaining: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  currentWinStreak: number;
  longestWinStreak: number;
  disputesInvolved: number;
  missedAccepts: number;
  /** Null when unplaced, since an unranked player has no ladder position. */
  position: number | null;
  team: { id: string; tag: string; name: string; role: string } | null;
}

/**
 * The public read side: the ladder, and anyone's profile.
 *
 * Both publish rank and record and never the rating, which is the same rule the
 * rest of the app follows. Ordering by rating server-side is fine -- the number
 * decides the order without ever being sent.
 *
 * Unplaced players are left off the ladder entirely rather than sorted in at
 * their provisional rating: a placement rating is a guess, and a ladder is a
 * claim about who is better.
 */
export class LadderService {
  constructor(private readonly db: Database) {}

  async top(limit: number, offset: number): Promise<LadderRow[]> {
    const rows = await this.db
      .select({
        userId: users.id,
        discordName: users.discordName,
        inGameName: users.inGameName,
        rating: playerRatings.rating,
        wins: playerRatings.wins,
        losses: playerRatings.losses,
        gamesPlayed: playerRatings.gamesPlayed,
        teamTag: teams.tag,
        position: sql<number>`ROW_NUMBER() OVER (
          ORDER BY ${playerRatings.rating} DESC, ${users.id}
        )::int`,
      })
      .from(playerRatings)
      .innerJoin(users, eq(users.id, playerRatings.userId))
      .leftJoin(teamMembers, eq(teamMembers.userId, users.id))
      .leftJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(sql`${playerRatings.gamesPlayed} >= ${PLACEMENT_GAMES}`)
      .orderBy(desc(playerRatings.rating), users.id)
      .limit(limit)
      .offset(offset);

    return rows.map((r) => ({
      position: r.position,
      userId: r.userId,
      discordName: r.discordName,
      inGameName: r.inGameName,
      tier: tierForRating(r.rating),
      wins: r.wins,
      losses: r.losses,
      gamesPlayed: r.gamesPlayed,
      teamTag: r.teamTag,
    }));
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(playerRatings)
      .where(sql`${playerRatings.gamesPlayed} >= ${PLACEMENT_GAMES}`);

    return row?.n ?? 0;
  }

  /**
   * Where one player sits, so someone outside the visible page still sees
   * their own standing rather than having to page until they find themselves.
   */
  async positionFor(userId: string): Promise<number | null> {
    const [me] = await this.db
      .select({ rating: playerRatings.rating, gamesPlayed: playerRatings.gamesPlayed })
      .from(playerRatings)
      .where(eq(playerRatings.userId, userId))
      .limit(1);

    if (!me || !isPlaced(me.gamesPlayed)) return null;

    // Ties break by id, matching the ladder's own ordering, so a position is
    // the same number wherever it is read from.
    const [row] = await this.db
      .select({ ahead: sql<number>`COUNT(*)::int` })
      .from(playerRatings)
      .innerJoin(users, eq(users.id, playerRatings.userId))
      .where(
        sql`${playerRatings.gamesPlayed} >= ${PLACEMENT_GAMES}
            AND (${playerRatings.rating} > ${me.rating}
                 OR (${playerRatings.rating} = ${me.rating} AND ${users.id} < ${userId}))`,
      );

    return (row?.ahead ?? 0) + 1;
  }

  async profile(userId: string): Promise<PublicProfile | null> {
    const [row] = await this.db
      .select({
        userId: users.id,
        discordName: users.discordName,
        inGameName: users.inGameName,
        rating: playerRatings.rating,
        peakRating: playerRatings.peakRating,
        gamesPlayed: playerRatings.gamesPlayed,
        wins: playerRatings.wins,
        losses: playerRatings.losses,
        currentWinStreak: playerRatings.currentWinStreak,
        longestWinStreak: playerRatings.longestWinStreak,
        disputesInvolved: playerRatings.disputesInvolved,
        missedAccepts: playerRatings.missedAccepts,
        teamId: teams.id,
        teamTag: teams.tag,
        teamName: teams.name,
        teamRole: teamMembers.role,
      })
      .from(users)
      .leftJoin(playerRatings, eq(playerRatings.userId, users.id))
      .leftJoin(teamMembers, eq(teamMembers.userId, users.id))
      .leftJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(users.id, userId))
      .limit(1);

    if (!row) return null;

    const games = row.gamesPlayed ?? 0;
    const placed = isPlaced(games);

    return {
      userId: row.userId,
      discordName: row.discordName,
      inGameName: row.inGameName,
      tier: placed ? tierForRating(row.rating ?? DEFAULT_RATING) : null,
      // Peak is only meaningful once there is a rank to have peaked at.
      peakTier: placed ? tierForRating(row.peakRating ?? DEFAULT_RATING) : null,
      placementsRemaining: placementGamesRemaining(games),
      gamesPlayed: games,
      wins: row.wins ?? 0,
      losses: row.losses ?? 0,
      currentWinStreak: row.currentWinStreak ?? 0,
      longestWinStreak: row.longestWinStreak ?? 0,
      disputesInvolved: row.disputesInvolved ?? 0,
      missedAccepts: row.missedAccepts ?? 0,
      position: placed ? await this.positionFor(userId) : null,
      team:
        row.teamId && row.teamTag && row.teamName
          ? { id: row.teamId, tag: row.teamTag, name: row.teamName, role: row.teamRole ?? "member" }
          : null,
    };
  }
}
