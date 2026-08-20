import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

export const inviteStatus = pgEnum("invite_status", [
  "pending",
  "accepted",
  "declined",
  "expired",
]);

/** Ephemeral groups that queue together. Distinct from persistent teams. */
export const parties = pgTable("parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  leaderId: uuid("leader_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partyMembers = pgTable(
  "party_members",
  {
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One party per user, enforced in schema rather than in service code.
    uniqueIndex("party_members_user_idx").on(t.userId),
    index("party_members_party_idx").on(t.partyId),
  ],
);

export const partyInvites = pgTable(
  "party_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    status: inviteStatus("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("party_invites_to_user_idx").on(t.toUserId, t.status)],
);

/**
 * Live queue tickets, one per queued party.
 *
 * The earlier version needed MMR bucketing, a separate ordering index,
 * cross-server heartbeats and a self-healing consistency check between two
 * in-memory maps — all to make a *distributed* queue scannable. A single
 * matchmaker process reading Postgres needs none of it.
 *
 * The heartbeat survives though, repurposed as WebSocket liveness: a ticket
 * whose client has gone quiet expires exactly as a stale ticket did, or the
 * queue fills with players who closed the app.
 */
export const queueTickets = pgTable(
  "queue_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),

    /** Regions the party will accept; any of them may pop first. */
    regions: text("regions").array().notNull(),

    /** Frozen at join so mid-queue rating changes cannot shift the search. */
    ratingSnapshot: integer("rating_snapshot").notNull(),
    size: integer("size").notNull(),

    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live ticket per party.
    uniqueIndex("queue_tickets_party_idx").on(t.partyId),
    // The matchmaker scans oldest-first so long-waiting parties anchor matches.
    index("queue_tickets_joined_at_idx").on(t.joinedAt),
    index("queue_tickets_rating_idx").on(t.ratingSnapshot),
  ],
);
