import {
  DEFAULT_RATING,
  REGIONS,
  TEAM_SIZE,
  type Result,
  fail,
  isPlaced,
  ok,
  tierForRating,
} from "@suddenqueue/core";
import { and, desc, eq, ne, sql } from "drizzle-orm";

import type { Database, Executor } from "../db/client.js";
import {
  playerRatings,
  scrimListings,
  scrimRequests,
  teamMembers,
  teams,
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
  | "WRONG_SIZE";

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
  ): Promise<Result<{ listingId: string }, ScrimError>> {
    if (!REGIONS.includes(input.region as (typeof REGIONS)[number])) {
      return fail("INVALID_REGION", "Pick a region the ladder runs in");
    }

    return this.db.transaction(async (tx) => {
      const manager = await this.requireManager(tx, userId);
      if (!manager.ok) return manager.error;

      if (manager.memberCount < TEAM_SIZE) {
        return fail("ROSTER_TOO_SMALL", `A scrim needs ${TEAM_SIZE} players a side`);
      }

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
      const manager = await this.requireManager(tx, userId);
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
  ): Promise<Result<{ requestId: string; hostTeamId: string }, ScrimError>> {
    return this.db.transaction(async (tx) => {
      const manager = await this.requireManager(tx, userId);
      if (!manager.ok) return manager.error;

      if (manager.memberCount < TEAM_SIZE) {
        return fail("ROSTER_TOO_SMALL", `A scrim needs ${TEAM_SIZE} players a side`);
      }

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
    const manager = await this.requireManager(this.db, userId);
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
  ): Promise<
    Result<
      {
        accepted: boolean;
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

      const manager = await this.requireManager(tx, userId);
      if (!manager.ok) return manager.error;
      if (manager.teamId !== listing.teamId) {
        return fail("NOT_A_MANAGER", "That request is not for your team");
      }

      await tx
        .update(scrimRequests)
        .set({ status: accept ? "accepted" : "declined", decidedAt: new Date() })
        .where(eq(scrimRequests.id, requestId));

      return ok({
        accepted: accept,
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

  /**
   * The five who play, and who reports for them.
   *
   * Seniority order with the captain pulled to the front. A team of ten cannot
   * pick its lineup yet -- that is the next thing scrims need, and it is a
   * feature rather than a fix, so it is not being smuggled in here.
   */
  async lineup(
    teamId: string,
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

    const ordered = [
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

  // ---------------------------------------------------------------- helpers

  /** Captain or officer of some team, which every action here requires. */
  private async requireManager(
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
    if (row.role !== "captain" && row.role !== "officer") {
      return {
        ok: false,
        error: fail("NOT_A_MANAGER", "Only the captain and officers arrange scrims"),
      };
    }

    const [count] = await tx
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, row.teamId));

    return { ok: true, teamId: row.teamId, memberCount: count?.n ?? 0 };
  }
}
