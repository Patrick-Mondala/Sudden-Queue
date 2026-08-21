import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { teams } from "./teams.js";
import { users } from "./users.js";

export const matchType = pgEnum("match_type", ["PUG", "SCRIM"]);

/**
 * Lifecycle. This enum plus the deadline columns below replace the entire
 * reservation store: a party whose match sits in PENDING_ACCEPT is, by
 * definition, reserved and excluded from the queue scan.
 */
export const matchState = pgEnum("match_state", [
  "PENDING_ACCEPT",
  "PARTY_UP",
  "LIVE",
  "REPORTED",
  "COMPLETED",
  "DISPUTED",
  "CANCELLED",
]);

export const matchResult = pgEnum("match_result", ["TEAM1", "TEAM2"]);

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: matchType("type").notNull(),
    region: text("region").notNull(),
    state: matchState("state").notNull().default("PENDING_ACCEPT"),

    /** Team-average ratings frozen at match creation, used to apply Elo. */
    team1Rating: integer("team1_rating").notNull(),
    team2Rating: integer("team2_rating").notNull(),

    /** Populated for SCRIM matches so team history can be queried both ways. */
    team1Id: uuid("team1_id").references(() => teams.id, { onDelete: "set null" }),
    team2Id: uuid("team2_id").references(() => teams.id, { onDelete: "set null" }),

    /**
     * Every transition carries a deadline. Without them one player closing the
     * app silently freezes nine others out of the queue, so a sweeper expires
     * whichever of these is currently in force.
     */
    acceptDeadline: timestamp("accept_deadline", { withTimezone: true }),
    partyUpDeadline: timestamp("party_up_deadline", { withTimezone: true }),
    reportDeadline: timestamp("report_deadline", { withTimezone: true }),

    result: matchResult("result"),
    /** True once rating deltas have been written to participants. Idempotency guard. */
    ratingApplied: boolean("rating_applied").notNull().default(false),

    cancelReason: text("cancel_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    // The sweeper scans open matches by state; the ladder reads resolved ones.
    index("matches_state_idx").on(t.state),
    index("matches_created_at_idx").on(t.createdAt),
    index("matches_team1_idx").on(t.team1Id),
    index("matches_team2_idx").on(t.team2Id),
  ],
);

/**
 * One row per player per match.
 *
 * `ratingBefore` and `ratingDelta` are the load-bearing columns. They were not
 * needed where a game server was authoritative and results were final.
 * Here a moderator can overturn a result days later, so reversal has to be exact
 * arithmetic rather than a recomputation against ratings that have since moved.
 */
export const matchParticipants = pgTable(
  "match_participants",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    team: smallint("team").notNull(),
    isCaptain: boolean("is_captain").notNull().default(false),

    /** Null until they accept; the accept sweep reads this. */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),

    ratingBefore: integer("rating_before"),
    ratingDelta: integer("rating_delta"),

  },
  (t) => [
    uniqueIndex("match_participants_pk").on(t.matchId, t.userId),
    index("match_participants_user_idx").on(t.userId),
  ],
);

/**
 * Captain attestations. A result only applies when both captains agree, so
 * there are at most two rows and agreement is a comparison between them.
 */
export const matchReports = pgTable(
  "match_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Which team the reporter captained. */
    reportingTeam: smallint("reporting_team").notNull(),
    /** Which team they claim won. */
    claimedWinner: matchResult("claimed_winner").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One report per captain per match — a resubmission updates rather than stacks.
    uniqueIndex("match_reports_match_reporter_idx").on(t.matchId, t.reporterId),
  ],
);

/**
 * Append-only rating corrections.
 *
 * Overturning a dispute writes the inverse delta with a reason rather than
 * mutating history, so the ledger always explains how a rating reached its
 * current value.
 */
export const ratingAdjustments = pgTable(
  "rating_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    matchId: uuid("match_id").references(() => matches.id, { onDelete: "set null" }),

    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    appliedBy: uuid("applied_by").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rating_adjustments_user_idx").on(t.userId)],
);
