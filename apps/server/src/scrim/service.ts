import {
  DEFAULT_RATING,
  REGIONS,
  SCRIM_LINEUP_SECONDS,
  TEAM_SIZE,
  type Result,
  fail,
  isPlaced,
  ok,
  placementGamesRemaining,
  tierForRating,
} from "@suddenqueue/core";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";

import { isGameMaster } from "../auth/roles.js";
import type { Database, Executor } from "../db/client.js";
import {
  playerRatings,
  scrimListings,
  scrimRequests,
  teamMembers,
  teams,
  users,
} from "../db/schema/index.js";

export interface ListingView {
  id: string;
  teamId: string;
  tag: string;
  name: string;
  region: string;
  note: string | null;
  postedAt: string;
  memberCount: number;
  tier: string | null;
  /** Set when the team reading this has a request in on the listing. */
  requested: boolean;
}

export interface RequestView {
  id: string;
  listingId: string;
  teamId: string;
  tag: string;
  name: string;
  tier: string | null;
  createdAt: string;
}

/** A lineup a captain still owes, and the roster to pick it from. */
export interface PendingLineup {
  requestId: string;
  opponentTag: string;
  opponentName: string;
  confirmDeadline: string;
  roster: {
    userId: string;
    discordName: string;
    inGameName: string | null;
    isGameMaster: boolean;
    isStarter: boolean;
    tier: string | null;
    placementsRemaining: number;
  }[];
}

export type ScrimError =
  | "NOT_IN_TEAM"
  | "NOT_A_MANAGER"
  | "ROSTER_TOO_SMALL"
  | "ALREADY_LISTED"
  | "LISTING_NOT_FOUND"
  | "OWN_LISTING"
  | "ALREADY_REQUESTED"
  | "REQUEST_NOT_FOUND"
  | "INVALID_REGION"
  | "PLAYER_BUSY"
  | "PLAYER_QUEUED"
  | "WRONG_SIZE"
  | "NOT_CAPTAIN"
  | "NOT_CONFIRMING"
  | "BAD_LINEUP"
  | "CAPTAIN_OFFLINE"
  | "NOT_ENOUGH_ONLINE";

/**
 * Scrims — practice matches between two registered teams.
 *
 * A scrim never touches rating. What it does share with a PUG is everything
 * after the handshake: the same twenty-second accept, the same party-up, the
 * same two-captain report. Only the way the ten players are chosen differs, and
 * that is the whole of this file.
 */
export class ScrimService {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------------ reads

  /** Open listings, newest first, excluding the reader's own team. */
  async openListings(viewerTeamId: string | null, region?: string): Promise<ListingView[]> {
    const rows = await this.db
      .select({
        id: scrimListings.id,
        teamId: scrimListings.teamId,
        region: scrimListings.region,
        note: scrimListings.note,
        postedAt: scrimListings.postedAt,
        tag: teams.tag,
        name: teams.name,
        memberCount: sql<number>`(
          SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = ${teams.id}
        )`,
        avgRating: sql<number | null>`(
          SELECT AVG(pr.rating) FROM team_members tm
          JOIN player_ratings pr ON pr.user_id = tm.user_id
          WHERE tm.team_id = ${teams.id} AND pr.games_played >= 5
        )`,
        requested: viewerTeamId
          ? sql<boolean>`EXISTS (
              SELECT 1 FROM scrim_requests sr
              WHERE sr.listing_id = ${scrimListings.id}
                AND sr.requesting_team_id = ${viewerTeamId}
                AND sr.status = 'pending'
            )`
          : sql<boolean>`FALSE`,
      })
      .from(scrimListings)
      .innerJoin(teams, eq(teams.id, scrimListings.teamId))
      .where(
        and(
          eq(scrimListings.status, "open"),
          region ? eq(scrimListings.region, region) : undefined,
          viewerTeamId ? ne(scrimListings.teamId, viewerTeamId) : undefined,
        ),
      )
      .orderBy(desc(scrimListings.postedAt));

    return rows.map((r) => ({
      id: r.id,
      teamId: r.teamId,
      tag: r.tag,
      name: r.name,
      region: r.region,
      note: r.note,
      postedAt: r.postedAt.toISOString(),
      memberCount: r.memberCount,
      tier: r.avgRating === null ? null : tierForRating(Math.round(Number(r.avgRating))),
      requested: Boolean(r.requested),
    }));
  }

  /** A team's own open listing, if it has one. */
  async listingFor(teamId: string): Promise<{ id: string; region: string; note: string | null } | null> {
    const [row] = await this.db
      .select({ id: scrimListings.id, region: scrimListings.region, note: scrimListings.note })
      .from(scrimListings)
      .where(and(eq(scrimListings.teamId, teamId), eq(scrimListings.status, "open")))
      .limit(1);

    return row ?? null;
  }

  /** Requests waiting on a team's own listing. */
  async incomingRequests(teamId: string): Promise<RequestView[]> {
    const rows = await this.db
      .select({
        id: scrimRequests.id,
        listingId: scrimRequests.listingId,
        teamId: scrimRequests.requestingTeamId,
        createdAt: scrimRequests.createdAt,
        tag: teams.tag,
        name: teams.name,
        avgRating: sql<number | null>`(
          SELECT AVG(pr.rating) FROM team_members tm
          JOIN player_ratings pr ON pr.user_id = tm.user_id
          WHERE tm.team_id = ${teams.id} AND pr.games_played >= 5
        )`,
      })
      .from(scrimRequests)
      .innerJoin(scrimListings, eq(scrimListings.id, scrimRequests.listingId))
      .innerJoin(teams, eq(teams.id, scrimRequests.requestingTeamId))
      .where(and(eq(scrimListings.teamId, teamId), eq(scrimRequests.status, "pending")))
      .orderBy(scrimRequests.createdAt);

    return rows.map((r) => ({
      id: r.id,
      listingId: r.listingId,
      teamId: r.teamId,
      tag: r.tag,
      name: r.name,
      tier: r.avgRating === null ? null : tierForRating(Math.round(Number(r.avgRating))),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ----------------------------------------------------------------- writes

  async postListing(
    userId: string,
    input: { region: string; note: string | null },
    online: ReadonlySet<string>,
  ): Promise<Result<{ listingId: string }, ScrimError>> {
    if (!REGIONS.includes(input.region as (typeof REGIONS)[number])) {
      return fail("INVALID_REGION", "Pick a region the ladder runs in");
    }

    return this.db.transaction(async (tx) => {
      const manager = await this.requireCaptain(tx, userId);
      if (!manager.ok) return manager.error;

      if (manager.memberCount < TEAM_SIZE) {
        return fail("ROSTER_TOO_SMALL", `A scrim needs ${TEAM_SIZE} players a side`);
      }

      const notReady = await this.readiness(tx, manager.teamId, online);
      if (notReady) return notReady;

      const [existing] = await tx
        .select({ id: scrimListings.id })
        .from(scrimListings)
        .where(and(eq(scrimListings.teamId, manager.teamId), eq(scrimListings.status, "open")))
        .limit(1);

      if (existing) return fail("ALREADY_LISTED", "Your team is already on the list");

      const [listing] = await tx
        .insert(scrimListings)
        .values({ teamId: manager.teamId, region: input.region, note: input.note })
        .returning({ id: scrimListings.id });

      return ok({ listingId: listing!.id });
    });
  }

  async removeListing(userId: string): Promise<Result<{ teamId: string }, ScrimError>> {
    return this.db.transaction(async (tx) => {
      const manager = await this.requireCaptain(tx, userId);
      if (!manager.ok) return manager.error;

      const rows = await tx
        .update(scrimListings)
        .set({ status: "removed" })
        .where(and(eq(scrimListings.teamId, manager.teamId), eq(scrimListings.status, "open")))
        .returning({ id: scrimListings.id });

      if (rows.length === 0) return fail("LISTING_NOT_FOUND", "Your team is not listed");

      // Anyone who asked while it was up is told it has gone, rather than
      // waiting on an answer that will never come.
      await tx
        .update(scrimRequests)
        .set({ status: "expired", decidedAt: new Date() })
        .where(
          and(eq(scrimRequests.listingId, rows[0]!.id), eq(scrimRequests.status, "pending")),
        );

      return ok({ teamId: manager.teamId });
    });
  }

  async request(
    userId: string,
    listingId: string,
    online: ReadonlySet<string>,
  ): Promise<Result<{ requestId: string; hostTeamId: string }, ScrimError>> {
    return this.db.transaction(async (tx) => {
      const manager = await this.requireCaptain(tx, userId);
      if (!manager.ok) return manager.error;

      if (manager.memberCount < TEAM_SIZE) {
        return fail("ROSTER_TOO_SMALL", `A scrim needs ${TEAM_SIZE} players a side`);
      }

      const notReady = await this.readiness(tx, manager.teamId, online);
      if (notReady) return notReady;

      const [listing] = await tx
        .select({ id: scrimListings.id, teamId: scrimListings.teamId, status: scrimListings.status })
        .from(scrimListings)
        .where(eq(scrimListings.id, listingId))
        .limit(1);

      if (!listing || listing.status !== "open") {
        return fail("LISTING_NOT_FOUND", "That listing has gone");
      }
      if (listing.teamId === manager.teamId) {
        return fail("OWN_LISTING", "That is your own listing");
      }

      const [already] = await tx
        .select({ id: scrimRequests.id })
        .from(scrimRequests)
        .where(
          and(
            eq(scrimRequests.listingId, listingId),
            eq(scrimRequests.requestingTeamId, manager.teamId),
            eq(scrimRequests.status, "pending"),
          ),
        )
        .limit(1);

      if (already) return fail("ALREADY_REQUESTED", "You have already asked this team");

      const [created] = await tx
        .insert(scrimRequests)
        .values({ listingId, requestingTeamId: manager.teamId })
        .returning({ id: scrimRequests.id });

      return ok({ requestId: created!.id, hostTeamId: listing.teamId });
    });
  }

  async withdrawRequest(userId: string, requestId: string): Promise<Result<void, ScrimError>> {
    const manager = await this.requireCaptain(this.db, userId);
    if (!manager.ok) return manager.error;

    const rows = await this.db
      .update(scrimRequests)
      .set({ status: "expired", decidedAt: new Date() })
      .where(
        and(
          eq(scrimRequests.id, requestId),
          eq(scrimRequests.requestingTeamId, manager.teamId),
          eq(scrimRequests.status, "pending"),
        ),
      )
      .returning({ id: scrimRequests.id });

    if (rows.length === 0) return fail("REQUEST_NOT_FOUND", "That request has gone");
    return ok();
  }

  /**
   * Accepts or declines a request.
   *
   * Accepting does not create the match here -- that needs the match lifecycle,
   * which this service deliberately does not reach into. It returns everything
   * the caller needs to commit one, and marks the listing matched only once the
   * caller says the match landed.
   */
  async decideRequest(
    userId: string,
    requestId: string,
    accept: boolean,
    online: ReadonlySet<string>,
  ): Promise<
    Result<
      {
        accepted: boolean;
        /** Both lineups are settled, so the match can be committed now. */
        ready: boolean;
        listingId: string;
        region: string;
        hostTeamId: string;
        guestTeamId: string;
      },
      ScrimError
    >
  > {
    return this.db.transaction(async (tx) => {
      const [request] = await tx
        .select({
          id: scrimRequests.id,
          status: scrimRequests.status,
          listingId: scrimRequests.listingId,
          requestingTeamId: scrimRequests.requestingTeamId,
        })
        .from(scrimRequests)
        .where(eq(scrimRequests.id, requestId))
        .for("update");

      if (!request || request.status !== "pending") {
        return fail("REQUEST_NOT_FOUND", "That request has already been answered");
      }

      const [listing] = await tx
        .select({ id: scrimListings.id, teamId: scrimListings.teamId, region: scrimListings.region, status: scrimListings.status })
        .from(scrimListings)
        .where(eq(scrimListings.id, request.listingId))
        .limit(1);

      if (!listing || listing.status !== "open") {
        return fail("LISTING_NOT_FOUND", "That listing has gone");
      }

      const manager = await this.requireCaptain(tx, userId);
      if (!manager.ok) return manager.error;
      if (manager.teamId !== listing.teamId) {
        return fail("NOT_A_MANAGER", "That request is not for your team");
      }

      if (!accept) {
        await tx
          .update(scrimRequests)
          .set({ status: "declined", decidedAt: new Date() })
          .where(eq(scrimRequests.id, requestId));

        return ok({
          accepted: false,
          ready: false,
          listingId: listing.id,
          region: listing.region,
          hostTeamId: listing.teamId,
          guestTeamId: request.requestingTeamId,
        });
      }

      // Both sides are checked again here, not just at listing time. A team
      // can go home between putting itself up and being asked, and this is
      // the moment ten people get committed to a match.
      for (const teamId of [listing.teamId, request.requestingTeamId]) {
        const notReady = await this.readiness(tx, teamId, online);
        if (notReady) return notReady;
      }

      // Both captains confirm, whatever their roster looks like.
      //
      // A team of exactly five was filled in here and never asked, on the
      // grounds that there is only one possible answer. But confirming is
      // not only picking who plays -- it is the captain saying the scrim is
      // on, that their five are around, and that they know it is starting.
      // A team that was never asked finds out it is in a match, which is a
      // worse answer than one extra click.
      const hostLine = null;
      const guestLine = null;

      await tx
        .update(scrimRequests)
        .set({
          status: "accepted",
          decidedAt: new Date(),
          hostLineup: hostLine,
          guestLineup: guestLine,
          confirmDeadline: new Date(Date.now() + SCRIM_LINEUP_SECONDS * 1000),
        })
        .where(eq(scrimRequests.id, requestId));

      return ok({
        accepted: true,
        ready: hostLine !== null && guestLine !== null,
        listingId: listing.id,
        region: listing.region,
        hostTeamId: listing.teamId,
        guestTeamId: request.requestingTeamId,
      });
    });
  }

  /** Closes a listing once its match is committed, and clears the rest. */
  async markMatched(listingId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(scrimListings)
        .set({ status: "matched" })
        .where(eq(scrimListings.id, listingId));

      await tx
        .update(scrimRequests)
        .set({ status: "expired", decidedAt: new Date() })
        .where(and(eq(scrimRequests.listingId, listingId), eq(scrimRequests.status, "pending")));
    });
  }

  /** Puts an accepted request back if the match could not be committed. */
  async reopen(listingId: string, requestId: string): Promise<void> {
    await this.db
      .update(scrimRequests)
      .set({ status: "pending", decidedAt: null })
      .where(eq(scrimRequests.id, requestId));
    await this.db
      .update(scrimListings)
      .set({ status: "open" })
      .where(eq(scrimListings.id, listingId));
  }

  /** What this player's team still owes, if they are the one who owes it. */
  async pendingLineupFor(userId: string): Promise<PendingLineup | null> {
    const [team] = await this.db
      .select({ teamId: teams.id, captainId: teams.captainId })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(teamMembers.userId, userId))
      .limit(1);

    // Picking who plays is the captain's call, so nobody else is asked.
    if (!team || team.captainId !== userId) return null;

    const [row] = await this.db
      .select({
        requestId: scrimRequests.id,
        hostLineup: scrimRequests.hostLineup,
        guestLineup: scrimRequests.guestLineup,
        confirmDeadline: scrimRequests.confirmDeadline,
        hostTeamId: scrimListings.teamId,
        guestTeamId: scrimRequests.requestingTeamId,
      })
      .from(scrimRequests)
      .innerJoin(scrimListings, eq(scrimListings.id, scrimRequests.listingId))
      .where(
        and(
          eq(scrimRequests.status, "accepted"),
          sql`(${scrimListings.teamId} = ${team.teamId} AND ${scrimRequests.hostLineup} IS NULL)
              OR (${scrimRequests.requestingTeamId} = ${team.teamId} AND ${scrimRequests.guestLineup} IS NULL)`,
        ),
      )
      .limit(1);

    if (!row) return null;

    const opponentId = row.hostTeamId === team.teamId ? row.guestTeamId : row.hostTeamId;
    const [opponent] = await this.db
      .select({ tag: teams.tag, name: teams.name })
      .from(teams)
      .where(eq(teams.id, opponentId))
      .limit(1);

    const roster = await this.db
      .select({
        userId: teamMembers.userId,
        isStarter: teamMembers.isStarter,
        discordName: users.discordName,
        inGameName: users.inGameName,
        accountRole: users.role,
        rating: playerRatings.rating,
        gamesPlayed: playerRatings.gamesPlayed,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .leftJoin(playerRatings, eq(playerRatings.userId, teamMembers.userId))
      .where(eq(teamMembers.teamId, team.teamId))
      .orderBy(desc(teamMembers.isStarter), teamMembers.joinedAt, teamMembers.userId);

    return {
      requestId: row.requestId,
      opponentTag: opponent?.tag ?? "",
      opponentName: opponent?.name ?? "the other team",
      confirmDeadline: (row.confirmDeadline ?? new Date()).toISOString(),
      roster: roster.map((r) => {
        const games = r.gamesPlayed ?? 0;
        return {
          userId: r.userId,
          discordName: r.discordName,
          inGameName: r.inGameName,
          isGameMaster: isGameMaster(r.accountRole),
          isStarter: r.isStarter,
          tier: isPlaced(games) ? tierForRating(r.rating ?? DEFAULT_RATING) : null,
          placementsRemaining: placementGamesRemaining(games),
        };
      }),
    };
  }

  /**
   * Records one captain's five.
   *
   * Returns whether both sides are now settled, which is the caller's cue to
   * commit the match -- this service still does not reach into the lifecycle.
   */
  async confirmLineup(
    captainId: string,
    requestId: string,
    userIds: string[],
  ): Promise<Result<{ ready: boolean; hostTeamId: string; guestTeamId: string; listingId: string; region: string }, ScrimError>> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: scrimRequests.id,
          status: scrimRequests.status,
          hostLineup: scrimRequests.hostLineup,
          guestLineup: scrimRequests.guestLineup,
          confirmDeadline: scrimRequests.confirmDeadline,
          guestTeamId: scrimRequests.requestingTeamId,
          listingId: scrimListings.id,
          hostTeamId: scrimListings.teamId,
          region: scrimListings.region,
        })
        .from(scrimRequests)
        .innerJoin(scrimListings, eq(scrimListings.id, scrimRequests.listingId))
        .where(eq(scrimRequests.id, requestId))
        .for("update");

      if (!row || row.status !== "accepted") {
        return fail("NOT_CONFIRMING", "That scrim is no longer waiting on a lineup");
      }
      if (row.confirmDeadline && row.confirmDeadline.getTime() <= Date.now()) {
        return fail("NOT_CONFIRMING", "That scrim timed out waiting for a lineup");
      }

      const [team] = await tx
        .select({ teamId: teams.id, captainId: teams.captainId })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(eq(teamMembers.userId, captainId))
        .limit(1);

      if (!team) return fail("NOT_IN_TEAM", "You are not in a team");
      if (team.captainId !== captainId) {
        return fail("NOT_CAPTAIN", "Only the captain confirms the lineup");
      }

      const isHost = row.hostTeamId === team.teamId;
      if (!isHost && row.guestTeamId !== team.teamId) {
        return fail("NOT_A_MANAGER", "That scrim is not yours");
      }

      // Five, no duplicates, and all of them actually on this roster -- the
      // client sends a selection, not a promise.
      const unique = [...new Set(userIds)];
      if (unique.length !== TEAM_SIZE) {
        return fail("BAD_LINEUP", `Pick exactly ${TEAM_SIZE} players`);
      }

      const onRoster = await tx
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, team.teamId), inArray(teamMembers.userId, unique)));

      if (onRoster.length !== TEAM_SIZE) {
        return fail("BAD_LINEUP", "Everyone you pick has to be on your roster");
      }

      await tx
        .update(scrimRequests)
        .set(isHost ? { hostLineup: unique } : { guestLineup: unique })
        .where(eq(scrimRequests.id, requestId));

      const otherSide = isHost ? row.guestLineup : row.hostLineup;

      return ok({
        ready: otherSide !== null,
        hostTeamId: row.hostTeamId,
        guestTeamId: row.guestTeamId,
        listingId: row.listingId,
        region: row.region,
      });
    });
  }

  /** The five each side settled on, once both have. */
  async lineupsFor(
    requestId: string,
  ): Promise<{ host: string[]; guest: string[] } | null> {
    const [row] = await this.db
      .select({ hostLineup: scrimRequests.hostLineup, guestLineup: scrimRequests.guestLineup })
      .from(scrimRequests)
      .where(eq(scrimRequests.id, requestId))
      .limit(1);

    if (!row?.hostLineup || !row.guestLineup) return null;
    return { host: row.hostLineup, guest: row.guestLineup };
  }

  /**
   * Drops scrims nobody finished confirming.
   *
   * The listing stays down rather than going back on the board: the host said
   * yes to a match and then did not field a team, so they can re-post when
   * they are actually ready. Nobody is penalised -- the accept prompt never
   * went out, so no one lost a match over it.
   */
  async expireUnconfirmed(): Promise<{ requestId: string; teamIds: string[] }[]> {
    const stale = await this.db
      .select({
        requestId: scrimRequests.id,
        listingId: scrimListings.id,
        hostTeamId: scrimListings.teamId,
        guestTeamId: scrimRequests.requestingTeamId,
      })
      .from(scrimRequests)
      .innerJoin(scrimListings, eq(scrimListings.id, scrimRequests.listingId))
      .where(
        and(
          eq(scrimRequests.status, "accepted"),
          lt(scrimRequests.confirmDeadline, new Date()),
        ),
      );

    const dropped = [];
    for (const row of stale) {
      await this.db
        .update(scrimRequests)
        .set({ status: "expired", decidedAt: new Date() })
        .where(eq(scrimRequests.id, row.requestId));
      await this.db
        .update(scrimListings)
        .set({ status: "removed" })
        .where(eq(scrimListings.id, row.listingId));

      dropped.push({
        requestId: row.requestId,
        teamIds: [row.hostTeamId, row.guestTeamId],
      });
    }

    return dropped;
  }

  /**
   * The five who play, and who reports for them.
   *
   * Seniority order with the captain pulled to the front. A team of ten cannot
   * pick its lineup yet -- that is the next thing scrims need, and it is a
   * feature rather than a fix, so it is not being smuggled in here.
   */
  async lineup(
    teamId: string,
    chosen?: string[],
  ): Promise<{ userIds: string[]; captainId: string; rating: number } | null> {
    const [team] = await this.db
      .select({ captainId: teams.captainId })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    if (!team) return null;

    const rows = await this.db
      .select({
        userId: teamMembers.userId,
        rating: playerRatings.rating,
        gamesPlayed: playerRatings.gamesPlayed,
      })
      .from(teamMembers)
      .leftJoin(playerRatings, eq(playerRatings.userId, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(teamMembers.joinedAt, teamMembers.userId);

    // A confirmed lineup is the answer; the seniority fallback only applies
    // to a roster of exactly five, which was never asked.
    const ordered = chosen
      ? rows.filter((r) => chosen.includes(r.userId))
      : [
          ...rows.filter((r) => r.userId === team.captainId),
          ...rows.filter((r) => r.userId !== team.captainId),
        ].slice(0, TEAM_SIZE);

    if (ordered.length < TEAM_SIZE) return null;

    const placed = ordered.filter((r) => isPlaced(r.gamesPlayed ?? 0));
    const pool = placed.length > 0 ? placed : ordered;
    const rating = Math.round(
      pool.reduce((sum, r) => sum + (r.rating ?? DEFAULT_RATING), 0) / pool.length,
    );

    return { userIds: ordered.map((r) => r.userId), captainId: team.captainId, rating };
  }

  /**
   * Whether a team can actually field a scrim right now.
   *
   * A scrim is an appointment for ten people in the next few minutes, so what
   * matters is who is here, not who is on the roster. The captain has to be
   * among them because only they confirm the lineup and only they report the
   * result -- arranging a match your captain cannot finish is worse than not
   * arranging one.
   *
   * Online is a fact about the socket table, so the caller passes it in rather
   * than this reaching for it.
   */
  private async readiness(
    tx: Executor,
    teamId: string,
    online: ReadonlySet<string>,
  ): Promise<Result<never, ScrimError> | null> {
    const [team] = await tx
      .select({ captainId: teams.captainId })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    if (!team) return fail("NOT_IN_TEAM", "You are not in a team");

    if (!online.has(team.captainId)) {
      return fail("CAPTAIN_OFFLINE", "You may not scrim while your captain is offline.");
    }

    const members = await tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId));

    const here = members.filter((m) => online.has(m.userId)).length;
    if (here < TEAM_SIZE) {
      return fail(
        "NOT_ENOUGH_ONLINE",
        `Your team does not have enough players online to scrim. ${here} of ${TEAM_SIZE} are here.`,
      );
    }

    return null;
  }

  // ---------------------------------------------------------------- helpers

  /** Captain or officer of some team, which every action here requires. */
  /**
   * Arranging a scrim is the captain's call and nobody else's.
   *
   * Officers run the roster -- they take applications and remove members -- but
   * a scrim commits ten people to a time, and the captain is the one who
   * answers for it. It is also the captain who must be online for the team to
   * be allowed to scrim at all, so letting an officer commit the team while the
   * captain is away would only produce a match nobody had agreed to.
   */
  private async requireCaptain(
    tx: Executor,
    userId: string,
  ): Promise<
    | { ok: true; teamId: string; memberCount: number }
    | { ok: false; error: Result<never, ScrimError> }
  > {
    const [row] = await tx
      .select({ teamId: teamMembers.teamId, role: teamMembers.role })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .limit(1);

    if (!row) return { ok: false, error: fail("NOT_IN_TEAM", "You are not in a team") };
    if (row.role !== "captain") {
      return {
        ok: false,
        error: fail("NOT_CAPTAIN", "Only the captain arranges scrims"),
      };
    }

    const [count] = await tx
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, row.teamId));

    return { ok: true, teamId: row.teamId, memberCount: count?.n ?? 0 };
  }
}
