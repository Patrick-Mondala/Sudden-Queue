import {
  TEAM_NAME_MAX_LENGTH,
  TEAM_TAG_MAX_LENGTH,
  type Result,
  fail,
  ok,
  tierForRating,
} from "@suddenqueue/core";
import { and, desc, eq, ne, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  auditLog,
  matches,
  playerRatings,
  queueTickets,
  ratingAdjustments,
  teams,
  users,
} from "../db/schema/index.js";

export type ManagementError =
  | "NOT_FOUND"
  | "INVALID"
  | "TAG_TAKEN"
  | "ALREADY_SETTLED";

export interface AuditEntry {
  id: string;
  eventType: string;
  actorId: string | null;
  actorName: string | null;
  subjectType: string | null;
  subjectId: string | null;
  payload: unknown;
  createdAt: string;
}

/**
 * The powers that used to need a database client.
 *
 * Everything here was previously reachable only by opening psql on the server:
 * lifting a cooldown, renaming a team somebody called something unrepeatable,
 * clearing an in-game name of the same kind, voiding a match that should never
 * have counted, correcting rating after a bug, and prising a stuck ticket out
 * of the queue.
 *
 * They are grouped rather than scattered across the services they touch
 * because they share a property those services do not: each one is a person
 * overriding what the system worked out, and every one of them writes to the
 * audit log. A power that leaves no trace is the kind that gets used quietly.
 */
export class ManagementService {
  constructor(private readonly db: Database) {}

  /**
   * Lifts a queue cooldown.
   *
   * Clears the escalation counter with it. The length of the next cooldown
   * comes from recent_missed_accepts rather than from the timestamp, so
   * lifting only the timestamp lets somebody queue now and then jumps them
   * straight up the ladder on their next miss -- which is not what "lifted"
   * means to the person it was lifted for.
   */
  async clearCooldown(actorId: string, userId: string): Promise<Result<void, ManagementError>> {
    const updated = await this.db
      .update(playerRatings)
      .set({ queueCooldownUntil: null, recentMissedAccepts: 0 })
      .where(eq(playerRatings.userId, userId))
      .returning({ userId: playerRatings.userId });

    if (updated.length === 0) return fail("NOT_FOUND", "No such player");

    await this.record(actorId, "cooldown.cleared", "user", userId, {});
    return ok();
  }

  /**
   * Clears somebody's in-game name.
   *
   * Cleared rather than replaced. A Game Master choosing a name for somebody
   * is a worse idea than the offensive one it replaced, and an empty name puts
   * the account straight back into the prompt that asks them to set one.
   */
  async clearInGameName(actorId: string, userId: string): Promise<Result<void, ManagementError>> {
    const [before] = await this.db
      .select({ inGameName: users.inGameName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!before) return fail("NOT_FOUND", "No such player");

    await this.db.update(users).set({ inGameName: null }).where(eq(users.id, userId));
    await this.record(actorId, "ingamename.cleared", "user", userId, {
      previous: before.inGameName,
    });

    return ok();
  }

  /** Renames a team, retags it, or both. */
  async renameTeam(
    actorId: string,
    teamId: string,
    changes: { name?: string; tag?: string },
  ): Promise<Result<void, ManagementError>> {
    const name = changes.name?.trim();
    const tag = changes.tag?.trim().toUpperCase();

    if (name !== undefined && (name.length === 0 || name.length > TEAM_NAME_MAX_LENGTH)) {
      return fail("INVALID", `A team name is 1 to ${TEAM_NAME_MAX_LENGTH} characters`);
    }
    if (tag !== undefined && (tag.length === 0 || tag.length > TEAM_TAG_MAX_LENGTH)) {
      return fail("INVALID", `A tag is 1 to ${TEAM_TAG_MAX_LENGTH} characters`);
    }
    if (name === undefined && tag === undefined) return fail("INVALID", "Nothing to change");

    const [before] = await this.db
      .select({ name: teams.name, tag: teams.tag })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    if (!before) return fail("NOT_FOUND", "No such team");

    if (tag !== undefined && tag !== before.tag) {
      const [clash] = await this.db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.tag, tag), ne(teams.id, teamId)))
        .limit(1);

      if (clash) return fail("TAG_TAKEN", "Another team already has that tag");
    }

    await this.db
      .update(teams)
      .set({ ...(name === undefined ? {} : { name }), ...(tag === undefined ? {} : { tag }) })
      .where(eq(teams.id, teamId));

    await this.record(actorId, "team.renamed", "team", teamId, {
      from: { name: before.name, tag: before.tag },
      to: { name: name ?? before.name, tag: tag ?? before.tag },
    });

    return ok();
  }

  /**
   * Takes a match out of the record entirely.
   *
   * Distinct from overturning it. Overturning says the other side won; this
   * says it should never have counted -- the wrong lineup, a bug, a match
   * nobody played. Rating that was applied is reversed through the ledger
   * rather than subtracted by hand, so the reversal is as visible as the
   * original award.
   *
   * Lands in CANCELLED rather than a state of its own. That value already
   * means "this did not count", which is what voiding says, and adding an
   * enum value costs a migration to record a distinction the audit entry
   * already carries -- a match nobody accepted and a match struck out
   * afterwards are told apart there.
   */
  async voidMatch(
    actorId: string,
    matchId: string,
    reason: string,
  ): Promise<Result<{ reversed: number }, ManagementError>> {
    return this.db.transaction(async (tx) => {
      const [match] = await tx
        .select()
        .from(matches)
        .where(eq(matches.id, matchId))
        .for("update");

      if (!match) return fail("NOT_FOUND", "No such match");
      if (match.state === "CANCELLED") return fail("ALREADY_SETTLED", "That match is already void");

      let reversed = 0;

      if (match.ratingApplied) {
        const awards = await tx
          .select({
            userId: ratingAdjustments.userId,
            delta: ratingAdjustments.delta,
          })
          .from(ratingAdjustments)
          .where(eq(ratingAdjustments.matchId, matchId));

        for (const award of awards) {
          await tx
            .update(playerRatings)
            .set({ rating: sql`${playerRatings.rating} - ${award.delta}` })
            .where(eq(playerRatings.userId, award.userId));

          // The reversal is its own row. A ledger you can edit is a ledger.
          await tx.insert(ratingAdjustments).values({
            matchId,
            userId: award.userId,
            delta: -award.delta,
            reason: "void",
            appliedBy: actorId,
          });

          reversed += 1;
        }
      }

      await tx
        .update(matches)
        .set({ state: "CANCELLED", ratingApplied: false, reportDeadline: null })
        .where(eq(matches.id, matchId));

      await this.record(actorId, "match.voided", "match", matchId, { reason, reversed });
      return ok({ reversed });
    });
  }

  /**
   * Corrects a rating by hand.
   *
   * Through the ledger, with a reason, rather than by writing a new number
   * over the old one. This exists for the morning after a bug moved rating
   * wrongly; it is not a way to reward anybody, and the audit trail is what
   * keeps that distinction checkable.
   */
  async adjustRating(
    actorId: string,
    userId: string,
    delta: number,
    reason: string,
  ): Promise<Result<{ rating: number; tier: string }, ManagementError>> {
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000) {
      return fail("INVALID", "An adjustment is a whole number between -1000 and 1000");
    }
    if (reason.trim().length === 0) {
      return fail("INVALID", "Say why: an unexplained adjustment is indistinguishable from a bug");
    }

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ rating: playerRatings.rating })
        .from(playerRatings)
        .where(eq(playerRatings.userId, userId))
        .for("update");

      if (!row) return fail("NOT_FOUND", "No such player");

      const after = Math.max(0, row.rating + delta);

      await tx.update(playerRatings).set({ rating: after }).where(eq(playerRatings.userId, userId));
      await tx.insert(ratingAdjustments).values({
        matchId: null,
        userId,
        delta: after - row.rating,
        reason: `manual: ${reason.trim()}`,
        appliedBy: actorId,
      });

      await this.record(actorId, "rating.adjusted", "user", userId, {
        before: row.rating,
        after,
        reason: reason.trim(),
      });

      return ok({ rating: after, tier: tierForRating(after) });
    });
  }

  /** Prises a stuck ticket out of the queue. */
  async removeFromQueue(
    actorId: string,
    partyId: string,
  ): Promise<Result<void, ManagementError>> {
    const removed = await this.db
      .delete(queueTickets)
      .where(eq(queueTickets.partyId, partyId))
      .returning({ partyId: queueTickets.partyId });

    if (removed.length === 0) return fail("NOT_FOUND", "That party is not in the queue");

    await this.record(actorId, "queue.removed", "party", partyId, {});
    return ok();
  }

  /** Everything staff have done, newest first. */
  async audit(limit = 100): Promise<AuditEntry[]> {
    const rows = await this.db
      .select({
        id: auditLog.id,
        eventType: auditLog.eventType,
        actorId: auditLog.actorId,
        actorName: sql<string | null>`${users.discordName}`,
        subjectType: auditLog.subjectType,
        subjectId: auditLog.subjectId,
        payload: auditLog.payload,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .orderBy(desc(auditLog.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500));

    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  private async record(
    actorId: string,
    eventType: string,
    subjectType: string,
    subjectId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .insert(auditLog)
      .values({ eventType, actorId, subjectType, subjectId, payload });
  }
}

