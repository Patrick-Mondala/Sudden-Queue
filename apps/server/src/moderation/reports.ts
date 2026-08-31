import { type Result, fail, ok } from "@suddenqueue/core";
import { and, desc, eq, inArray } from "drizzle-orm";

import { isGameMaster } from "../auth/roles.js";
import type { Database } from "../db/client.js";
import { playerReports, playerRatings, users } from "../db/schema/index.js";

/** Long enough to say what happened, short enough that somebody will read it. */
export const REPORT_REASON_MAX_LENGTH = 500;
export const REPORT_REASON_MIN_LENGTH = 3;

export type ReportError =
  | "SELF_REPORT"
  | "SUBJECT_NOT_FOUND"
  | "INVALID_REASON"
  | "NOT_FOUND";

export interface MyReport {
  subjectId: string;
  reason: string;
  status: "open" | "actioned" | "dismissed";
  createdAt: string;
  updatedAt: string;
}

export interface ReportForReview {
  id: string;
  reason: string;
  status: "open" | "actioned" | "dismissed";
  createdAt: string;
  updatedAt: string;
  reporter: { userId: string; discordName: string; inGameName: string | null };
  reviewNote: string | null;
  reviewedAt: string | null;
}

/** A player somebody has complained about, with everything said about them. */
export interface ReportedPlayer {
  userId: string;
  discordName: string;
  inGameName: string | null;
  isGameMaster: boolean;
  tier: string | null;
  openCount: number;
  totalCount: number;
  /** Newest first: the thing that just happened is the thing being asked about. */
  latestAt: string;
  reports: ReportForReview[];
}

/**
 * Players reporting players.
 *
 * One row per reporter and subject, so the queue measures how many people have
 * a problem with somebody rather than how many times one person clicked. The
 * message is editable for the same reason it is one row: the useful version of
 * a report is usually the second one, written after the reporter has calmed
 * down enough to say what actually happened.
 *
 * Nothing here punishes anybody. A report is a request that a human look, and
 * the looking is done in the management tab with the powers that live there.
 */
export class ReportService {
  constructor(private readonly db: Database) {}

  /**
   * Files a report, or rewrites the one already filed.
   *
   * Editing reopens it. A report that a Game Master dismissed and the reporter
   * has since rewritten is a new complaint wearing an old row, and leaving it
   * closed would quietly swallow it.
   */
  async file(
    reporterId: string,
    subjectId: string,
    reason: string,
  ): Promise<Result<MyReport, ReportError>> {
    if (reporterId === subjectId) {
      return fail("SELF_REPORT", "You cannot report yourself");
    }

    const trimmed = reason.trim();
    if (trimmed.length < REPORT_REASON_MIN_LENGTH || trimmed.length > REPORT_REASON_MAX_LENGTH) {
      return fail(
        "INVALID_REASON",
        `Say what happened, in ${REPORT_REASON_MIN_LENGTH} to ${REPORT_REASON_MAX_LENGTH} characters`,
      );
    }

    const [subject] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, subjectId))
      .limit(1);

    if (!subject) return fail("SUBJECT_NOT_FOUND", "No such player");

    const now = new Date();
    const [row] = await this.db
      .insert(playerReports)
      .values({ reporterId, subjectId, reason: trimmed })
      .onConflictDoUpdate({
        target: [playerReports.reporterId, playerReports.subjectId],
        set: {
          reason: trimmed,
          updatedAt: now,
          status: "open",
          reviewedBy: null,
          reviewNote: null,
          reviewedAt: null,
        },
      })
      .returning({
        subjectId: playerReports.subjectId,
        reason: playerReports.reason,
        status: playerReports.status,
        createdAt: playerReports.createdAt,
        updatedAt: playerReports.updatedAt,
      });

    return ok({
      subjectId: row!.subjectId,
      reason: row!.reason,
      status: row!.status,
      createdAt: row!.createdAt.toISOString(),
      updatedAt: row!.updatedAt.toISOString(),
    });
  }

  /** What this reporter has already said about that player, if anything. */
  async mine(reporterId: string, subjectId: string): Promise<MyReport | null> {
    const [row] = await this.db
      .select({
        subjectId: playerReports.subjectId,
        reason: playerReports.reason,
        status: playerReports.status,
        createdAt: playerReports.createdAt,
        updatedAt: playerReports.updatedAt,
      })
      .from(playerReports)
      .where(
        and(eq(playerReports.reporterId, reporterId), eq(playerReports.subjectId, subjectId)),
      )
      .limit(1);

    if (!row) return null;

    return {
      subjectId: row.subjectId,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Takes a report back. Theirs to withdraw as much as it was theirs to file. */
  async withdraw(reporterId: string, subjectId: string): Promise<Result<void, ReportError>> {
    const removed = await this.db
      .delete(playerReports)
      .where(
        and(eq(playerReports.reporterId, reporterId), eq(playerReports.subjectId, subjectId)),
      )
      .returning({ id: playerReports.id });

    if (removed.length === 0) return fail("NOT_FOUND", "You have not reported that player");
    return ok();
  }

  /**
   * The queue, grouped by who was reported rather than by report.
   *
   * Five people reporting one player is one problem, not five, and a list of
   * individual reports buries that -- the number that matters when deciding
   * where to look is how many separate people bothered.
   */
  async pending(includeClosed = false): Promise<ReportedPlayer[]> {
    const rows = await this.db
      .select({
        id: playerReports.id,
        reason: playerReports.reason,
        status: playerReports.status,
        createdAt: playerReports.createdAt,
        updatedAt: playerReports.updatedAt,
        reviewNote: playerReports.reviewNote,
        reviewedAt: playerReports.reviewedAt,
        subjectId: playerReports.subjectId,
        subjectName: users.discordName,
        reporterId: playerReports.reporterId,
      })
      .from(playerReports)
      .innerJoin(users, eq(users.id, playerReports.subjectId))
      .where(includeClosed ? undefined : eq(playerReports.status, "open"))
      .orderBy(desc(playerReports.updatedAt));

    if (rows.length === 0) return [];

    // Names and ranks for both sides, in one round trip rather than per row.
    const ids = [...new Set(rows.flatMap((r) => [r.subjectId, r.reporterId]))];
    const people = await this.db
      .select({
        id: users.id,
        discordName: users.discordName,
        inGameName: users.inGameName,
        role: users.role,
        rating: playerRatings.rating,
        gamesPlayed: playerRatings.gamesPlayed,
      })
      .from(users)
      .leftJoin(playerRatings, eq(playerRatings.userId, users.id))
      .where(inArray(users.id, ids));

    const byId = new Map(people.map((p) => [p.id, p]));
    const grouped = new Map<string, ReportedPlayer>();

    for (const r of rows) {
      const subject = byId.get(r.subjectId);
      const reporter = byId.get(r.reporterId);

      let entry = grouped.get(r.subjectId);
      if (!entry) {
        entry = {
          userId: r.subjectId,
          discordName: subject?.discordName ?? r.subjectName,
          inGameName: subject?.inGameName ?? null,
          isGameMaster: isGameMaster(subject?.role ?? "player"),
          tier: null,
          openCount: 0,
          totalCount: 0,
          latestAt: r.updatedAt.toISOString(),
          reports: [],
        };
        grouped.set(r.subjectId, entry);
      }

      entry.totalCount += 1;
      if (r.status === "open") entry.openCount += 1;
      entry.reports.push({
        id: r.id,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        reviewNote: r.reviewNote,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
        reporter: {
          userId: r.reporterId,
          discordName: reporter?.discordName ?? "",
          inGameName: reporter?.inGameName ?? null,
        },
      });
    }

    return [...grouped.values()];
  }

  /** Closes one report, with a note saying what was decided. */
  async review(
    reportId: string,
    reviewerId: string,
    status: "actioned" | "dismissed",
    note: string | null,
  ): Promise<Result<void, ReportError>> {
    const updated = await this.db
      .update(playerReports)
      .set({
        status,
        reviewedBy: reviewerId,
        reviewNote: note?.trim() || null,
        reviewedAt: new Date(),
      })
      .where(eq(playerReports.id, reportId))
      .returning({ id: playerReports.id });

    if (updated.length === 0) return fail("NOT_FOUND", "No such report");
    return ok();
  }
}
