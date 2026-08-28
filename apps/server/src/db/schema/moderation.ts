import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { matches } from "./matches.js";
import { users } from "./users.js";

export const disputeStatus = pgEnum("dispute_status", [
  "open",
  "resolved",
  "dismissed",
]);

/**
 * Raised when captains disagree on a result, or when one never reports.
 *
 * Rating is applied on agreement, so an overturned dispute usually means
 * "never applied" rather than "applied and reversed" — the cheaper case.
 */
export const disputes = pgTable(
  "disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),

    reason: text("reason").notNull(),
    status: disputeStatus("status").notNull().default("open"),

    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolutionNote: text("resolution_note"),

    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("disputes_status_idx").on(t.status, t.openedAt)],
);

/**
 * Structured event log, ported from the earlier system's audit log.
 *
 * Wider scope here than there: with results self-attested, this is the evidence
 * a Game Master reads when deciding a dispute, and the source for the statistical
 * abuse flags (disagreement rate per captain, rating velocity outliers).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),

    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),

    payload: jsonb("payload"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_event_type_idx").on(t.eventType, t.createdAt),
    index("audit_log_actor_idx").on(t.actorId, t.createdAt),
    index("audit_log_subject_idx").on(t.subjectType, t.subjectId),
  ],
);
