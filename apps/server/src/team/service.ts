import {
  DEFAULT_RATING,
  MAX_TEAM_SIZE,
  REGIONS,
  TEAM_NAME_MAX_LENGTH,
  TEAM_TAG_MAX_LENGTH,
  type Result,
  fail,
  isPlaced,
  ok,
  placementGamesRemaining,
  tierForRating,
} from "@suddenqueue/core";
import { and, eq, sql } from "drizzle-orm";

import type { Database, Executor } from "../db/client.js";
import {
  playerRatings,
  teamApplications,
  teamMembers,
  teams,
  users,
} from "../db/schema/index.js";

export type TeamRole = "captain" | "officer" | "member";

export interface TeamMemberView {
  userId: string;
  discordName: string;
  inGameName: string | null;
  role: TeamRole;
  /** Rank only; the rating behind it is not published. */
  tier: string | null;
  placementsRemaining: number;
  joinedAt: string;
}

export interface TeamView {
  id: string;
  tag: string;
  name: string;
  region: string;
  captainId: string;
  applicationsOpen: boolean;
  createdAt: string;
  members: TeamMemberView[];
}

export interface TeamSummary {
  id: string;
  tag: string;
  name: string;
  region: string;
  applicationsOpen: boolean;
  memberCount: number;
  /** Average rank across the roster, or null while nobody is placed. */
  tier: string | null;
}

export interface ApplicationView {
  id: string;
  teamId: string;
  userId: string;
  discordName: string;
  inGameName: string | null;
  tier: string | null;
  placementsRemaining: number;
  note: string | null;
  createdAt: string;
}

export type TeamError =
  | "ALREADY_IN_TEAM"
  | "NOT_IN_TEAM"
  | "TEAM_NOT_FOUND"
  | "TEAM_FULL"
  | "TAG_TAKEN"
  | "INVALID_TAG"
  | "INVALID_NAME"
  | "INVALID_REGION"
  | "NOT_CAPTAIN"
  | "NOT_A_MANAGER"
  | "NOT_A_MEMBER"
  | "CANNOT_REMOVE_CAPTAIN"
  | "APPLICATIONS_CLOSED"
  | "ALREADY_APPLIED"
  | "APPLICATION_NOT_FOUND";

/**
 * Registered teams — persistent rosters, distinct from the throwaway parties
 * that queue for a PUG.
 *
 * There is no equivalent to port: the earlier system only ever had parties. The
 * shape here follows the rules the design called for — one team per
 * player, any number of officers, captains and officers manage the roster, and
 * a player may only have one application outstanding at a time.
 */
export class TeamService {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------------ reads

  async teamIdFor(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .limit(1);

    return row?.teamId ?? null;
  }

  async view(teamId: string): Promise<TeamView | null> {
    const [team] = await this.db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
    if (!team) return null;

    const rows = await this.db
      .select({
        userId: users.id,
        discordName: users.discordName,
        inGameName: users.inGameName,
        role: teamMembers.role,
        joinedAt: teamMembers.joinedAt,
        rating: playerRatings.rating,
        gamesPlayed: playerRatings.gamesPlayed,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .leftJoin(playerRatings, eq(playerRatings.userId, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(teamMembers.joinedAt, teamMembers.userId);

    return {
      id: team.id,
      tag: team.tag,
      name: team.name,
      region: team.region,
      captainId: team.captainId,
      applicationsOpen: team.applicationsOpen,
      createdAt: team.createdAt.toISOString(),
      members: rows.map((r) => {
        const games = r.gamesPlayed ?? 0;
        return {
          userId: r.userId,
          discordName: r.discordName,
          inGameName: r.inGameName,
          // The stored role and the captain column could disagree after a
          // transfer; the team row is the one that decides.
          role: r.userId === team.captainId ? "captain" : (r.role as TeamRole),
          tier: isPlaced(games) ? tierForRating(r.rating ?? DEFAULT_RATING) : null,
          placementsRemaining: placementGamesRemaining(games),
          joinedAt: r.joinedAt.toISOString(),
        };
      }),
    };
  }

  /**
   * The team list, newest first.
   *
   * The average is taken over placed members only: including an unplaced
   * player at the default rating would drag a good roster's rank down for no
   * reason other than someone being new.
   */
  async list(region?: string): Promise<TeamSummary[]> {
    const rows = await this.db
      .select({
        id: teams.id,
        tag: teams.tag,
        name: teams.name,
        region: teams.region,
        applicationsOpen: teams.applicationsOpen,
        createdAt: teams.createdAt,
        memberCount: sql<number>`COUNT(${teamMembers.userId})::int`,
        avgRating: sql<
          number | null
        >`AVG(${playerRatings.rating}) FILTER (WHERE ${playerRatings.gamesPlayed} >= 5)`,
      })
      .from(teams)
      .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .leftJoin(playerRatings, eq(playerRatings.userId, teamMembers.userId))
      .where(region ? eq(teams.region, region) : undefined)
      .groupBy(teams.id)
      .orderBy(sql`${teams.createdAt} DESC`);

    return rows.map((r) => ({
      id: r.id,
      tag: r.tag,
      name: r.name,
      region: r.region,
      applicationsOpen: r.applicationsOpen,
      memberCount: r.memberCount,
      tier: r.avgRating === null ? null : tierForRating(Math.round(Number(r.avgRating))),
    }));
  }

  /** Applications waiting on a team's managers. */
  async pendingApplications(teamId: string): Promise<ApplicationView[]> {
    const rows = await this.db
      .select({
        id: teamApplications.id,
        teamId: teamApplications.teamId,
        userId: teamApplications.userId,
        note: teamApplications.note,
        createdAt: teamApplications.createdAt,
        discordName: users.discordName,
        inGameName: users.inGameName,
        rating: playerRatings.rating,
        gamesPlayed: playerRatings.gamesPlayed,
      })
      .from(teamApplications)
      .innerJoin(users, eq(users.id, teamApplications.userId))
      .leftJoin(playerRatings, eq(playerRatings.userId, teamApplications.userId))
      .where(and(eq(teamApplications.teamId, teamId), eq(teamApplications.status, "pending")))
      .orderBy(teamApplications.createdAt);

    return rows.map((r) => {
      const games = r.gamesPlayed ?? 0;
      return {
        id: r.id,
        teamId: r.teamId,
        userId: r.userId,
        discordName: r.discordName,
        inGameName: r.inGameName,
        tier: isPlaced(games) ? tierForRating(r.rating ?? DEFAULT_RATING) : null,
        placementsRemaining: placementGamesRemaining(games),
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  /** The one application a player may have outstanding, if any. */
  async myApplication(userId: string): Promise<{ id: string; teamId: string } | null> {
    const [row] = await this.db
      .select({ id: teamApplications.id, teamId: teamApplications.teamId })
      .from(teamApplications)
      .where(and(eq(teamApplications.userId, userId), eq(teamApplications.status, "pending")))
      .limit(1);

    return row ?? null;
  }

  // ----------------------------------------------------------------- writes

  async create(
    userId: string,
    input: { tag: string; name: string; region: string },
  ): Promise<Result<{ teamId: string }, TeamError>> {
    const tag = input.tag.trim().toUpperCase();
    const name = input.name.trim();

    if (tag.length === 0 || tag.length > TEAM_TAG_MAX_LENGTH || !/^[A-Z0-9]+$/.test(tag)) {
      return fail("INVALID_TAG", `A tag is 1-${TEAM_TAG_MAX_LENGTH} letters or digits`);
    }
    if (name.length === 0 || name.length > TEAM_NAME_MAX_LENGTH) {
      return fail("INVALID_NAME", `A name is 1-${TEAM_NAME_MAX_LENGTH} characters`);
    }
    if (!REGIONS.includes(input.region as (typeof REGIONS)[number])) {
      return fail("INVALID_REGION", "Pick a region the ladder runs in");
    }

    return this.db.transaction(async (tx) => {
      if (await this.teamIdForIn(tx, userId)) {
        return fail("ALREADY_IN_TEAM", "Leave your current team first");
      }

      const [existing] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.tag, tag))
        .limit(1);
      if (existing) return fail("TAG_TAKEN", `The tag ${tag} is taken`);

      const [team] = await tx
        .insert(teams)
        .values({ tag, name, region: input.region, captainId: userId })
        .returning({ id: teams.id });

      await tx
        .insert(teamMembers)
        .values({ teamId: team!.id, userId, role: "captain" });

      // Registering settles whatever they had outstanding: they have a team now.
      await this.withdrawApplications(tx, userId);

      return ok({ teamId: team!.id });
    });
  }

  async apply(
    userId: string,
    teamId: string,
    note: string | null,
  ): Promise<Result<{ applicationId: string }, TeamError>> {
    return this.db.transaction(async (tx) => {
      if (await this.teamIdForIn(tx, userId)) {
        return fail("ALREADY_IN_TEAM", "Leave your current team first");
      }

      const [team] = await tx
        .select({ id: teams.id, applicationsOpen: teams.applicationsOpen })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);

      if (!team) return fail("TEAM_NOT_FOUND", "That team no longer exists");
      if (!team.applicationsOpen) {
        return fail("APPLICATIONS_CLOSED", "That team is not taking applications");
      }

      if (await this.countMembers(tx, teamId) >= MAX_TEAM_SIZE) {
        return fail("TEAM_FULL", "That roster is full");
      }

      // One at a time, so a player cannot paper the ladder with applications
      // and leave managers reviewing someone who has already joined elsewhere.
      const [pending] = await tx
        .select({ id: teamApplications.id })
        .from(teamApplications)
        .where(
          and(eq(teamApplications.userId, userId), eq(teamApplications.status, "pending")),
        )
        .limit(1);

      if (pending) return fail("ALREADY_APPLIED", "You already have an application pending");

      const [application] = await tx
        .insert(teamApplications)
        .values({ teamId, userId, note })
        .returning({ id: teamApplications.id });

      return ok({ applicationId: application!.id });
    });
  }

  async withdrawApplication(userId: string): Promise<Result<void, TeamError>> {
    const rows = await this.db
      .update(teamApplications)
      .set({ status: "withdrawn", decidedAt: new Date() })
      .where(and(eq(teamApplications.userId, userId), eq(teamApplications.status, "pending")))
      .returning({ id: teamApplications.id });

    if (rows.length === 0) return fail("APPLICATION_NOT_FOUND", "Nothing to withdraw");
    return ok();
  }

  async decideApplication(
    deciderId: string,
    applicationId: string,
    accept: boolean,
  ): Promise<Result<{ teamId: string; userId: string; joined: boolean }, TeamError>> {
    return this.db.transaction(async (tx) => {
      const [application] = await tx
        .select()
        .from(teamApplications)
        .where(eq(teamApplications.id, applicationId))
        .for("update");

      if (!application || application.status !== "pending") {
        return fail("APPLICATION_NOT_FOUND", "That application has already been dealt with");
      }

      const manages = await this.canManage(tx, deciderId, application.teamId);
      if (!manages) return fail("NOT_A_MANAGER", "Only the captain and officers review these");

      if (accept) {
        // Both can have changed since they applied: they may have joined
        // somewhere else, and the roster may have filled up.
        if (await this.teamIdForIn(tx, application.userId)) {
          await tx
            .update(teamApplications)
            .set({ status: "withdrawn", decidedAt: new Date(), decidedBy: deciderId })
            .where(eq(teamApplications.id, applicationId));
          return fail("ALREADY_IN_TEAM", "They have joined another team since applying");
        }

        if (await this.countMembers(tx, application.teamId) >= MAX_TEAM_SIZE) {
          return fail("TEAM_FULL", "Your roster is full");
        }

        await tx
          .insert(teamMembers)
          .values({ teamId: application.teamId, userId: application.userId, role: "member" });
      }

      await tx
        .update(teamApplications)
        .set({
          status: accept ? "accepted" : "denied",
          decidedAt: new Date(),
          decidedBy: deciderId,
        })
        .where(eq(teamApplications.id, applicationId));

      return ok({ teamId: application.teamId, userId: application.userId, joined: accept });
    });
  }

  async setApplicationsOpen(
    userId: string,
    teamId: string,
    open: boolean,
  ): Promise<Result<void, TeamError>> {
    if (!(await this.canManage(this.db, userId, teamId))) {
      return fail("NOT_A_MANAGER", "Only the captain and officers can change this");
    }

    await this.db.update(teams).set({ applicationsOpen: open }).where(eq(teams.id, teamId));
    return ok();
  }

  /** Promotes to officer or demotes back to member. Captain only. */
  async setRole(
    captainId: string,
    targetUserId: string,
    role: "officer" | "member",
  ): Promise<Result<{ teamId: string }, TeamError>> {
    return this.db.transaction(async (tx) => {
      const teamId = await this.teamIdForIn(tx, captainId);
      if (!teamId) return fail("NOT_IN_TEAM", "You are not in a team");

      const [team] = await tx
        .select({ captainId: teams.captainId })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);

      if (team!.captainId !== captainId) {
        return fail("NOT_CAPTAIN", "Only the captain appoints officers");
      }
      if (targetUserId === captainId) {
        return fail("NOT_A_MEMBER", "The captain already outranks an officer");
      }

      const rows = await tx
        .update(teamMembers)
        .set({ role })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)))
        .returning({ userId: teamMembers.userId });

      if (rows.length === 0) return fail("NOT_A_MEMBER", "They are not on your roster");
      return ok({ teamId });
    });
  }

  /** Hands the team to someone else. The old captain stays on as an officer. */
  async transferCaptaincy(
    captainId: string,
    targetUserId: string,
  ): Promise<Result<{ teamId: string }, TeamError>> {
    return this.db.transaction(async (tx) => {
      const teamId = await this.teamIdForIn(tx, captainId);
      if (!teamId) return fail("NOT_IN_TEAM", "You are not in a team");

      const [team] = await tx
        .select({ captainId: teams.captainId })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);

      if (team!.captainId !== captainId) return fail("NOT_CAPTAIN", "You are not the captain");
      if (targetUserId === captainId) return fail("NOT_A_MEMBER", "You already are the captain");

      const [target] = await tx
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)))
        .limit(1);

      if (!target) return fail("NOT_A_MEMBER", "They are not on your roster");

      await tx.update(teams).set({ captainId: targetUserId }).where(eq(teams.id, teamId));
      await tx
        .update(teamMembers)
        .set({ role: "captain" })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)));
      await tx
        .update(teamMembers)
        .set({ role: "officer" })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, captainId)));

      return ok({ teamId });
    });
  }

  async removeMember(
    actorId: string,
    targetUserId: string,
  ): Promise<Result<{ teamId: string }, TeamError>> {
    return this.db.transaction(async (tx) => {
      const teamId = await this.teamIdForIn(tx, actorId);
      if (!teamId) return fail("NOT_IN_TEAM", "You are not in a team");

      if (!(await this.canManage(tx, actorId, teamId))) {
        return fail("NOT_A_MANAGER", "Only the captain and officers can remove players");
      }

      const [team] = await tx
        .select({ captainId: teams.captainId })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);

      if (targetUserId === team!.captainId) {
        // The captain leaves by handing the team on or disbanding it, so there
        // is never a team whose captain column points at nobody.
        return fail("CANNOT_REMOVE_CAPTAIN", "The captain cannot be removed");
      }

      const rows = await tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)))
        .returning({ userId: teamMembers.userId });

      if (rows.length === 0) return fail("NOT_A_MEMBER", "They are not on your roster");
      return ok({ teamId });
    });
  }

  /**
   * Leaving.
   *
   * A captain who is the last one out takes the team with them; otherwise the
   * captaincy passes to the longest-serving officer, or failing that the
   * longest-serving member. The alternative -- refusing to let a captain leave
   * -- strands anyone whose team has gone quiet.
   */
  async leave(userId: string): Promise<Result<{ teamId: string; disbanded: boolean }, TeamError>> {
    return this.db.transaction(async (tx) => {
      const teamId = await this.teamIdForIn(tx, userId);
      if (!teamId) return fail("NOT_IN_TEAM", "You are not in a team");

      await tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));

      const remaining = await tx
        .select({ userId: teamMembers.userId, role: teamMembers.role })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId))
        .orderBy(teamMembers.joinedAt, teamMembers.userId);

      if (remaining.length === 0) {
        await tx.delete(teams).where(eq(teams.id, teamId));
        return ok({ teamId, disbanded: true });
      }

      const [team] = await tx
        .select({ captainId: teams.captainId })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);

      if (team!.captainId === userId) {
        const heir = remaining.find((r) => r.role === "officer") ?? remaining[0]!;
        await tx.update(teams).set({ captainId: heir.userId }).where(eq(teams.id, teamId));
        await tx
          .update(teamMembers)
          .set({ role: "captain" })
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, heir.userId)));
      }

      return ok({ teamId, disbanded: false });
    });
  }

  async disband(captainId: string): Promise<Result<{ teamId: string; memberIds: string[] }, TeamError>> {
    return this.db.transaction(async (tx) => {
      const teamId = await this.teamIdForIn(tx, captainId);
      if (!teamId) return fail("NOT_IN_TEAM", "You are not in a team");

      const [team] = await tx
        .select({ captainId: teams.captainId })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);

      if (team!.captainId !== captainId) {
        return fail("NOT_CAPTAIN", "Only the captain can disband the team");
      }

      const members = await tx
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId));

      // Members and applications cascade from the team row.
      await tx.delete(teams).where(eq(teams.id, teamId));

      return ok({ teamId, memberIds: members.map((m) => m.userId) });
    });
  }

  // ---------------------------------------------------------------- helpers

  private async teamIdForIn(tx: Executor, userId: string): Promise<string | null> {
    const [row] = await tx
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId))
      .limit(1);

    return row?.teamId ?? null;
  }

  private async countMembers(tx: Executor, teamId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId));

    return row?.n ?? 0;
  }

  /** Captain or officer. The two have the same powers over the roster. */
  private async canManage(tx: Executor, userId: string, teamId: string): Promise<boolean> {
    const [row] = await tx
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .limit(1);

    return row?.role === "captain" || row?.role === "officer";
  }

  private async withdrawApplications(tx: Executor, userId: string): Promise<void> {
    await tx
      .update(teamApplications)
      .set({ status: "withdrawn", decidedAt: new Date() })
      .where(and(eq(teamApplications.userId, userId), eq(teamApplications.status, "pending")));
  }
}
