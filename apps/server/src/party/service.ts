import {
  DEFAULT_RATING,
  INVITE_EXPIRATION_SECONDS,
  INVITE_RATE_LIMIT,
  INVITE_RATE_WINDOW_SECONDS,
  INVITE_REPEAT_COOLDOWN_SECONDS,
  MAX_PARTY_SIZE,
  type Result,
  fail,
  isPlaced,
  ok,
  placementGamesRemaining,
  tierForRating,
} from "@suddenqueue/core";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { isGameMaster } from "../auth/roles.js";
import type { Database, Executor } from "../db/client.js";
import {
  parties,
  partyInvites,
  partyMembers,
  playerRatings,
  queueTickets,
  users,
} from "../db/schema/index.js";

export interface PartyMemberView {
  userId: string;
  discordName: string;
  inGameName: string | null;
  avatarUrl: string | null;
  isGameMaster: boolean;
  /** Rank only; the rating behind it is not published. */
  tier: string | null;
  placementsRemaining: number;
  gamesPlayed: number;
  isLeader: boolean;
}

export interface PartyView {
  partyId: string;
  leaderId: string;
  members: PartyMemberView[];
  queued: boolean;
}

type PartyError =
  | "NO_PARTY"
  | "NOT_LEADER"
  | "PARTY_FULL"
  | "ALREADY_IN_PARTY"
  | "TARGET_IN_PARTY"
  | "INVITE_NOT_FOUND"
  | "INVITE_EXPIRED"
  | "CANNOT_INVITE_SELF"
  | "NOT_A_MEMBER"
  | "QUEUED"
  | "RATE_LIMITED"
  | "RECENTLY_INVITED"
  | "TARGET_QUEUED"
  | "INVITER_NOT_LEADER";

/**
 * Parties — ephemeral groups that queue together, distinct from persistent
 * teams.
 *
 * Every player always has a party, created lazily as a party of one, so the
 * queue only ever deals in party ids and there is no "solo or party" branch
 * anywhere downstream.
 */
export class PartyService {
  constructor(private readonly db: Database) {}

  /** The player's party, creating a solo one if they have none. */
  async ensureParty(userId: string): Promise<string> {
    const existing = await this.db
      .select({ partyId: partyMembers.partyId })
      .from(partyMembers)
      .where(eq(partyMembers.userId, userId))
      .limit(1);

    if (existing[0]) return existing[0].partyId;

    return this.db.transaction(async (tx) => {
      // Re-check inside the transaction: two tabs signing in together would
      // otherwise both create a party and one would violate the unique index.
      const again = await tx
        .select({ partyId: partyMembers.partyId })
        .from(partyMembers)
        .where(eq(partyMembers.userId, userId))
        .limit(1);

      if (again[0]) return again[0].partyId;

      const [party] = await tx
        .insert(parties)
        .values({ leaderId: userId })
        .returning({ id: parties.id });

      await tx.insert(partyMembers).values({ partyId: party!.id, userId });
      return party!.id;
    });
  }

  async view(partyId: string): Promise<PartyView | null> {
    const [party] = await this.db
      .select({ id: parties.id, leaderId: parties.leaderId })
      .from(parties)
      .where(eq(parties.id, partyId))
      .limit(1);

    if (!party) return null;

    const rows = await this.db
      .select({
        userId: users.id,
        discordName: users.discordName,
        inGameName: users.inGameName,
        avatarUrl: users.avatarUrl,
        role: users.role,
        rating: playerRatings.rating,
        gamesPlayed: playerRatings.gamesPlayed,
        joinedAt: partyMembers.joinedAt,
      })
      .from(partyMembers)
      .innerJoin(users, eq(users.id, partyMembers.userId))
      .leftJoin(playerRatings, eq(playerRatings.userId, partyMembers.userId))
      .where(eq(partyMembers.partyId, partyId))
      .orderBy(partyMembers.joinedAt, partyMembers.userId);

    const queued = await this.isQueued(partyId);

    return {
      partyId: party.id,
      leaderId: party.leaderId,
      queued,
      members: rows.map((r) => ({
        userId: r.userId,
        discordName: r.discordName,
        inGameName: r.inGameName,
        avatarUrl: r.avatarUrl,
        isGameMaster: isGameMaster(r.role),
        // Rank, not rating: a party member's points are no more publishable
        // than an opponent's.
        tier: isPlaced(r.gamesPlayed ?? 0) ? tierForRating(r.rating ?? DEFAULT_RATING) : null,
        placementsRemaining: placementGamesRemaining(r.gamesPlayed ?? 0),
        gamesPlayed: r.gamesPlayed ?? 0,
        isLeader: r.userId === party.leaderId,
      })),
    };
  }

  async partyIdFor(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ partyId: partyMembers.partyId })
      .from(partyMembers)
      .where(eq(partyMembers.userId, userId))
      .limit(1);

    return row?.partyId ?? null;
  }

  async isQueued(partyId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: queueTickets.id })
      .from(queueTickets)
      .where(eq(queueTickets.partyId, partyId))
      .limit(1);

    return row !== undefined;
  }

  /** Average rating across members, used as the queue ticket's snapshot. */
  async averageRating(partyId: string, fallback: number): Promise<number> {
    const [row] = await this.db
      .select({
        avg: sql<number>`COALESCE(ROUND(AVG(${playerRatings.rating})), ${fallback})::int`,
      })
      .from(partyMembers)
      .leftJoin(playerRatings, eq(playerRatings.userId, partyMembers.userId))
      .where(eq(partyMembers.partyId, partyId));

    return row?.avg ?? fallback;
  }

  async memberCount(partyId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(partyMembers)
      .where(eq(partyMembers.partyId, partyId));

    return row?.n ?? 0;
  }

  /** Invites a player. Only the leader may invite, and never while queued. */
  async invite(
    inviterId: string,
    targetUserId: string,
  ): Promise<Result<{ inviteId: string; partyId: string }, PartyError>> {
    if (inviterId === targetUserId) {
      return fail("CANNOT_INVITE_SELF", "You cannot invite yourself");
    }

    const partyId = await this.ensureParty(inviterId);

    const [party] = await this.db
      .select({ leaderId: parties.leaderId })
      .from(parties)
      .where(eq(parties.id, partyId));

    if (party!.leaderId !== inviterId) {
      return fail("NOT_LEADER", "Only the party leader can invite");
    }

    if (await this.isQueued(partyId)) {
      return fail("QUEUED", "Leave the queue before changing the party");
    }

    if ((await this.memberCount(partyId)) >= MAX_PARTY_SIZE) {
      return fail("PARTY_FULL", `A party holds at most ${MAX_PARTY_SIZE} players`);
    }

    // Throttling is read back off the invite rows rather than held in memory,
    // so a restart does not hand everyone a fresh allowance.
    const throttle = await this.inviteThrottle(inviterId, targetUserId);
    if (throttle) return throttle;

    // Someone already grouped up has to leave that party first.
    const targetParty = await this.partyIdFor(targetUserId);
    if (targetParty) {
      const n = await this.memberCount(targetParty);
      if (n > 1) return fail("TARGET_IN_PARTY", "That player is already in a party");

      // Accepting would delete their solo party and take its queue ticket with
      // it, so they would lose their place in line without being asked.
      if (await this.isQueued(targetParty)) {
        return fail("TARGET_QUEUED", "That player is in the queue right now");
      }
    }

    const [invite] = await this.db
      .insert(partyInvites)
      .values({
        partyId,
        fromUserId: inviterId,
        toUserId: targetUserId,
        expiresAt: new Date(Date.now() + INVITE_EXPIRATION_SECONDS * 1000),
      })
      .returning({ id: partyInvites.id });

    return ok({ inviteId: invite!.id, partyId });
  }

  /**
   * Whether this invite is allowed yet, and if not, when it will be.
   *
   * Declined and expired invites still count. Not counting them would mean the
   * fastest way to keep inviting someone is to have them decline, which is
   * exactly backwards.
   */
  private async inviteThrottle(
    inviterId: string,
    targetUserId: string,
  ): Promise<Result<never, PartyError> | null> {
    const windowStart = new Date(Date.now() - INVITE_RATE_WINDOW_SECONDS * 1000);
    const repeatSince = new Date(Date.now() - INVITE_REPEAT_COOLDOWN_SECONDS * 1000);

    // Two plain queries rather than one with aggregate FILTERs: Postgres cannot
    // infer the type of a uuid parameter compared inside a FILTER clause, and
    // the whole statement fails rather than the comparison.
    const [repeat] = await this.db
      .select({ at: partyInvites.createdAt })
      .from(partyInvites)
      .where(
        and(
          eq(partyInvites.fromUserId, inviterId),
          eq(partyInvites.toUserId, targetUserId),
          gt(partyInvites.createdAt, repeatSince),
        ),
      )
      .orderBy(desc(partyInvites.createdAt))
      .limit(1);

    if (repeat) {
      const readyAt = repeat.at.getTime() + INVITE_REPEAT_COOLDOWN_SECONDS * 1000;
      const seconds = Math.max(1, Math.ceil((readyAt - Date.now()) / 1000));
      return fail("RECENTLY_INVITED", `You invited them just now — try again in ${seconds}s`);
    }

    const inWindow = await this.db
      .select({ at: partyInvites.createdAt })
      .from(partyInvites)
      .where(
        and(eq(partyInvites.fromUserId, inviterId), gt(partyInvites.createdAt, windowStart)),
      )
      .orderBy(partyInvites.createdAt);

    if (inWindow.length >= INVITE_RATE_LIMIT) {
      // The allowance frees up as the oldest invite in the window ages out.
      const readyAt = inWindow[0]!.at.getTime() + INVITE_RATE_WINDOW_SECONDS * 1000;
      const seconds = Math.max(1, Math.ceil((readyAt - Date.now()) / 1000));
      return fail("RATE_LIMITED", `Too many invites — try again in ${seconds}s`);
    }

    return null;
  }

  async pendingInvitesFor(userId: string) {
    return this.db
      .select({
        inviteId: partyInvites.id,
        partyId: partyInvites.partyId,
        fromUserId: partyInvites.fromUserId,
        fromName: users.discordName,
        fromAvatarUrl: users.avatarUrl,
        expiresAt: partyInvites.expiresAt,
      })
      .from(partyInvites)
      .innerJoin(users, eq(users.id, partyInvites.fromUserId))
      .where(
        and(
          eq(partyInvites.toUserId, userId),
          eq(partyInvites.status, "pending"),
          gt(partyInvites.expiresAt, new Date()),
        ),
      );
  }

  /**
   * Accepts an invite: leaves the current party and joins the inviting one,
   * atomically so a failure cannot leave the player in neither.
   */
  async accept(
    userId: string,
    inviteId: string,
  ): Promise<Result<{ partyId: string; leftPartyId: string | null }, PartyError>> {
    return this.db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(partyInvites)
        .where(and(eq(partyInvites.id, inviteId), eq(partyInvites.toUserId, userId)))
        .for("update");

      if (!invite || invite.status !== "pending") {
        return fail("INVITE_NOT_FOUND", "Invite not found");
      }

      if (invite.expiresAt.getTime() <= Date.now()) {
        await tx
          .update(partyInvites)
          .set({ status: "expired" })
          .where(eq(partyInvites.id, inviteId));
        return fail("INVITE_EXPIRED", "That invite has expired");
      }

      const [target] = await tx
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(partyMembers)
        .where(eq(partyMembers.partyId, invite.partyId));

      if ((target?.n ?? 0) >= MAX_PARTY_SIZE) {
        return fail("PARTY_FULL", "That party filled up");
      }

      const queued = await tx
        .select({ id: queueTickets.id })
        .from(queueTickets)
        .where(eq(queueTickets.partyId, invite.partyId))
        .limit(1);

      if (queued[0]) return fail("QUEUED", "That party is already in the queue");

      // The invite was an offer from a leader. If they have since left or been
      // replaced, accepting would drop you into a party nobody in it asked for.
      const [host] = await tx
        .select({ leaderId: parties.leaderId })
        .from(parties)
        .where(eq(parties.id, invite.partyId));

      if (!host) return fail("INVITE_NOT_FOUND", "That party no longer exists");
      if (host.leaderId !== invite.fromUserId) {
        return fail("INVITER_NOT_LEADER", "Whoever invited you no longer leads that party");
      }

      // Leave the old party, cleaning it up if it is left empty.
      const [current] = await tx
        .select({ partyId: partyMembers.partyId })
        .from(partyMembers)
        .where(eq(partyMembers.userId, userId));

      // Accepting an invite leaves whatever you were in. The caller is handed
      // the party you left so the people still in it can be told.
      let leftPartyId: string | null = null;
      if (current) {
        leftPartyId = current.partyId === invite.partyId ? null : current.partyId;
        await tx.delete(partyMembers).where(eq(partyMembers.userId, userId));
        await this.settleParty(tx, current.partyId);
      }

      await tx.insert(partyMembers).values({ partyId: invite.partyId, userId });
      await tx
        .update(partyInvites)
        .set({ status: "accepted" })
        .where(eq(partyInvites.id, inviteId));

      return ok({ partyId: invite.partyId, leftPartyId });
    });
  }

  async decline(userId: string, inviteId: string): Promise<Result<void, PartyError>> {
    const rows = await this.db
      .update(partyInvites)
      .set({ status: "declined" })
      .where(
        and(
          eq(partyInvites.id, inviteId),
          eq(partyInvites.toUserId, userId),
          eq(partyInvites.status, "pending"),
        ),
      )
      .returning({ id: partyInvites.id });

    if (rows.length === 0) return fail("INVITE_NOT_FOUND", "Invite not found");
    return ok();
  }

  /** Leaves the current party into a fresh solo one. */
  async leave(userId: string): Promise<Result<{ partyId: string }, PartyError>> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ partyId: partyMembers.partyId })
        .from(partyMembers)
        .where(eq(partyMembers.userId, userId));

      if (!current) return fail("NO_PARTY", "You are not in a party");

      const queued = await tx
        .select({ id: queueTickets.id })
        .from(queueTickets)
        .where(eq(queueTickets.partyId, current.partyId))
        .limit(1);

      if (queued[0]) return fail("QUEUED", "Leave the queue first");

      await tx.delete(partyMembers).where(eq(partyMembers.userId, userId));
      await this.settleParty(tx, current.partyId);

      const [fresh] = await tx
        .insert(parties)
        .values({ leaderId: userId })
        .returning({ id: parties.id });
      await tx.insert(partyMembers).values({ partyId: fresh!.id, userId });

      return ok({ partyId: fresh!.id });
    });
  }

  /** Removes another member. Leader only. */
  async kick(
    leaderId: string,
    targetUserId: string,
  ): Promise<Result<{ partyId: string }, PartyError>> {
    if (leaderId === targetUserId) {
      return fail("NOT_A_MEMBER", "Use leave to remove yourself");
    }

    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ partyId: partyMembers.partyId })
        .from(partyMembers)
        .where(eq(partyMembers.userId, leaderId));

      if (!current) return fail("NO_PARTY", "You are not in a party");

      const [party] = await tx
        .select({ leaderId: parties.leaderId })
        .from(parties)
        .where(eq(parties.id, current.partyId));

      if (party!.leaderId !== leaderId) {
        return fail("NOT_LEADER", "Only the party leader can remove players");
      }

      const queued = await tx
        .select({ id: queueTickets.id })
        .from(queueTickets)
        .where(eq(queueTickets.partyId, current.partyId))
        .limit(1);

      if (queued[0]) return fail("QUEUED", "Leave the queue before changing the party");

      const removed = await tx
        .delete(partyMembers)
        .where(
          and(
            eq(partyMembers.userId, targetUserId),
            eq(partyMembers.partyId, current.partyId),
          ),
        )
        .returning({ userId: partyMembers.userId });

      if (removed.length === 0) return fail("NOT_A_MEMBER", "That player is not in your party");

      // Put them back in a solo party so they are never party-less.
      const [fresh] = await tx
        .insert(parties)
        .values({ leaderId: targetUserId })
        .returning({ id: parties.id });
      await tx.insert(partyMembers).values({ partyId: fresh!.id, userId: targetUserId });

      return ok({ partyId: current.partyId });
    });
  }

  /** Hands leadership to the longest-standing remaining member, or deletes. */
  /**
   * Settles a party after someone leaves it.
   *
   * Deletes it when nobody is left, and promotes the longest-standing member
   * when the leader is no longer among them. Keyed on whether the leader is
   * still present rather than on who just left, so a party cannot end up
   * pointing at a leader who is not in it by any route.
   */
  private async settleParty(tx: Executor, partyId: string) {
    const remaining = await tx
      .select({ userId: partyMembers.userId })
      .from(partyMembers)
      .where(eq(partyMembers.partyId, partyId))
      .orderBy(partyMembers.joinedAt, partyMembers.userId);

    if (remaining.length === 0) {
      await tx.delete(parties).where(eq(parties.id, partyId));
      return;
    }

    const [party] = await tx
      .select({ leaderId: parties.leaderId })
      .from(parties)
      .where(eq(parties.id, partyId));

    if (!remaining.some((r) => r.userId === party?.leaderId)) {
      await tx
        .update(parties)
        .set({ leaderId: remaining[0]!.userId })
        .where(eq(parties.id, partyId));
    }
  }

  /** Expires stale invites. Cheap, safe to run on the sweeper's timer. */
  async expireInvites(): Promise<number> {
    const rows = await this.db
      .update(partyInvites)
      .set({ status: "expired" })
      .where(
        and(eq(partyInvites.status, "pending"), sql`${partyInvites.expiresAt} <= now()`),
      )
      .returning({ id: partyInvites.id });

    return rows.length;
  }

  /** All member ids for a set of parties, for fan-out notification. */
  async memberIds(partyIds: string[]): Promise<string[]> {
    if (partyIds.length === 0) return [];

    const rows = await this.db
      .select({ userId: partyMembers.userId })
      .from(partyMembers)
      .where(inArray(partyMembers.partyId, partyIds));

    return rows.map((r) => r.userId);
  }
}
