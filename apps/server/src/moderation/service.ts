import { type Result, fail, ok } from "@suddenqueue/core";
import { and, desc, eq, gt, ilike, or, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { auditLog, users } from "../db/schema/index.js";
import type { Role } from "../auth/roles.js";

/**
 * Suspensions are timed, from an hour to a year.
 *
 * There is deliberately no permanent ban. A sentinel far-future date is a
 * lie the rest of the system has to keep believing, and a year is long enough
 * that the difference is academic -- while leaving every suspension something
 * a Game Master can simply lift.
 */
export const MIN_SUSPENSION_HOURS = 1;
export const MAX_SUSPENSION_HOURS = 8760;

export const SUSPENSION_REASON_MAX_LENGTH = 500;

export type ModerationError =
  | "USER_NOT_FOUND"
  | "CANNOT_SUSPEND_SELF"
  | "CANNOT_SUSPEND_STAFF"
  | "INVALID_DURATION"
  | "INVALID_REASON"
  | "NOT_SUSPENDED";

export interface Actor {
  userId: string;
  role: Role;
}

export interface Suspension {
  userId: string;
  discordName: string;
  until: Date;
  reason: string;
}

/** One ban as it was handed down, for the record rather than the to-do list. */
export interface BanRecord {
  id: string;
  userId: string | null;
  discordName: string | null;
  inGameName: string | null;
  /** Who handed it down. Null if that account has since been deleted. */
  byName: string | null;
  reason: string | null;
  hours: number | null;
  until: string | null;
  /** Whether this ban is still running, which a later one may have replaced. */
  active: boolean;
  at: string;
}

/** Identity only. Nothing here carries a rating, and nothing should. */
export interface ModeratedUser {
  userId: string;
  discordId: string;
  discordName: string;
  avatarUrl: string | null;
  inGameName: string | null;
  role: Role;
  bannedUntil: Date | null;
  banReason: string | null;
}

export interface ModerationEntry {
  id: string;
  eventType: string;
  actorId: string | null;
  actorName: string | null;
  payload: unknown;
  createdAt: Date;
}

const USER_FIELDS = {
  userId: users.id,
  discordId: users.discordId,
  discordName: users.discordName,
  avatarUrl: users.avatarUrl,
  inGameName: users.inGameName,
  role: users.role,
  bannedUntil: users.bannedUntil,
  banReason: users.banReason,
};

/**
 * Game Master actions against an account.
 *
 * The account columns this writes were already read in two places -- login and
 * queue entry -- and written in none, so a suspension was enforceable but not
 * issuable. Every action lands in the audit log, because a moderator power with
 * no record of who used it and why is the kind that gets misused quietly and
 * argued about loudly.
 */
export class ModerationService {
  constructor(private readonly db: Database) {}

  async suspend(
    actor: Actor,
    targetUserId: string,
    hours: number,
    reason: string,
  ): Promise<Result<Suspension, ModerationError>> {
    if (targetUserId === actor.userId) {
      return fail("CANNOT_SUSPEND_SELF", "You cannot suspend your own account");
    }
    if (!Number.isFinite(hours) || hours < MIN_SUSPENSION_HOURS || hours > MAX_SUSPENSION_HOURS) {
      return fail(
        "INVALID_DURATION",
        `A suspension runs from ${MIN_SUSPENSION_HOURS} hour to ${MAX_SUSPENSION_HOURS} hours`,
      );
    }

    const trimmed = reason.trim();
    if (trimmed.length === 0 || trimmed.length > SUSPENSION_REASON_MAX_LENGTH) {
      // The person is told this reason when they are turned away, and it is
      // what a later Game Master reads to decide whether it was fair.
      return fail("INVALID_REASON", "Give a reason, under 500 characters");
    }

    const [target] = await this.db.select(USER_FIELDS).from(users).where(eq(users.id, targetUserId));
    if (!target) return fail("USER_NOT_FOUND", "No such account");

    // An admin can act on a Game Master; nobody acts on an admin through here.
    // Two Game Masters suspending each other is not a dispute this should be
    // able to have.
    const staff = target.role === "admin" || (target.role === "game_master" && actor.role !== "admin");
    if (staff) {
      return fail("CANNOT_SUSPEND_STAFF", `${target.discordName} cannot be suspended from here`);
    }

    const until = new Date(Date.now() + hours * 3_600_000);

    await this.db
      .update(users)
      .set({ bannedUntil: until, banReason: trimmed })
      .where(eq(users.id, targetUserId));

    await this.record(actor.userId, "user.suspended", targetUserId, {
      hours,
      reason: trimmed,
      until: until.toISOString(),
      previousUntil: target.bannedUntil?.toISOString() ?? null,
    });

    return ok({ userId: targetUserId, discordName: target.discordName, until, reason: trimmed });
  }

  async lift(
    actor: Actor,
    targetUserId: string,
    note: string,
  ): Promise<Result<{ userId: string; discordName: string }, ModerationError>> {
    const [target] = await this.db.select(USER_FIELDS).from(users).where(eq(users.id, targetUserId));
    if (!target) return fail("USER_NOT_FOUND", "No such account");

    const active = (target.bannedUntil?.getTime() ?? 0) > Date.now();
    if (!active) return fail("NOT_SUSPENDED", `${target.discordName} is not suspended`);

    await this.db
      .update(users)
      .set({ bannedUntil: null, banReason: null })
      .where(eq(users.id, targetUserId));

    await this.record(actor.userId, "user.reinstated", targetUserId, {
      note: note.trim().slice(0, SUSPENSION_REASON_MAX_LENGTH),
      liftedFrom: target.bannedUntil?.toISOString() ?? null,
      originalReason: target.banReason,
    });

    return ok({ userId: targetUserId, discordName: target.discordName });
  }

  /** Everyone currently serving a suspension, soonest to end first. */
  async suspended(): Promise<ModeratedUser[]> {
    return this.db
      .select(USER_FIELDS)
      .from(users)
      .where(gt(users.bannedUntil, new Date()))
      .orderBy(users.bannedUntil);
  }

  /**
   * Bans handed down, most recent first, spent ones included.
   *
   * Different question from `suspended`, which asks who cannot sign in right
   * now and sorts by when they get back. This asks what has been done and
   * when, so it reads as a record rather than a to-do list -- and a ban that
   * has since expired is still part of that record.
   *
   * Read from the audit log rather than from the accounts, because an account
   * carries only its current state: one row per ban, including the several a
   * repeat offender collected on the way to their last one.
   */
  async banHistory(limit = 100): Promise<BanRecord[]> {
    const rows = await this.db
      .select({
        id: auditLog.id,
        subjectId: auditLog.subjectId,
        actorId: auditLog.actorId,
        actorName: sql<string | null>`actor.discord_name`,
        subjectName: sql<string | null>`subject.discord_name`,
        subjectInGameName: sql<string | null>`subject.in_game_name`,
        subjectBannedUntil: sql<Date | null>`subject.banned_until`,
        payload: auditLog.payload,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(sql`${users} AS actor`, sql`actor.id = ${auditLog.actorId}`)
      .leftJoin(sql`${users} AS subject`, sql`subject.id = ${auditLog.subjectId}`)
      .where(eq(auditLog.eventType, "user.suspended"))
      .orderBy(desc(auditLog.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));

    const now = Date.now();
    return rows.map((r) => {
      const until = (r.payload as { until?: string } | null)?.until ?? null;
      return {
        id: r.id,
        userId: r.subjectId,
        discordName: r.subjectName,
        inGameName: r.subjectInGameName,
        byName: r.actorName,
        reason: (r.payload as { reason?: string } | null)?.reason ?? null,
        hours: (r.payload as { hours?: number } | null)?.hours ?? null,
        until,
        // Whether this particular ban is still running, which is not the same
        // as whether the account is banned -- a later one may have replaced it.
        active: until !== null && new Date(until).getTime() > now,
        at: r.createdAt.toISOString(),
      };
    });
  }

  /**
   * Finds an account to act on.
   *
   * A Game Master is given a Discord name, or a Discord id pasted out of a
   * report -- rarely our own uuid -- so all three have to work.
   */
  async search(query: string, limit = 20): Promise<ModeratedUser[]> {
    const q = query.trim();
    if (q.length === 0) return [];

    const like = `%${q}%`;
    const conditions = [
      ilike(users.discordName, like),
      ilike(users.inGameName, like),
      eq(users.discordId, q),
    ];

    return this.db
      .select(USER_FIELDS)
      .from(users)
      .where(or(...conditions))
      .orderBy(users.discordName)
      .limit(Math.min(Math.max(limit, 1), 50));
  }

  async userFor(userId: string): Promise<ModeratedUser | null> {
    const [row] = await this.db.select(USER_FIELDS).from(users).where(eq(users.id, userId));
    return row ?? null;
  }

  /** What has been done to this account, most recent first. */
  async historyFor(userId: string, limit = 50): Promise<ModerationEntry[]> {
    return this.db
      .select({
        id: auditLog.id,
        eventType: auditLog.eventType,
        actorId: auditLog.actorId,
        actorName: sql<string | null>`${users.discordName}`,
        payload: auditLog.payload,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(and(eq(auditLog.subjectType, "user"), eq(auditLog.subjectId, userId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  private async record(
    actorId: string,
    eventType: string,
    subjectId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(auditLog).values({
      eventType,
      actorId,
      subjectType: "user",
      subjectId,
      payload,
    });
  }
}
