import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

export const teamRole = pgEnum("team_role", ["member", "officer", "captain"]);

export const applicationStatus = pgEnum("application_status", [
  "pending",
  "accepted",
  "denied",
  "withdrawn",
]);

export const scrimListingStatus = pgEnum("scrim_listing_status", [
  "open",
  "matched",
  "removed",
]);

export const scrimRequestStatus = pgEnum("scrim_request_status", [
  "pending",
  "accepted",
  "declined",
  "expired",
]);

/** Persistent rosters. No earlier equivalent — that system only had parties. */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tag: text("tag").notNull(),
    name: text("name").notNull(),
    region: text("region").notNull(),
    captainId: uuid("captain_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    applicationsOpen: boolean("applications_open").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("teams_tag_idx").on(t.tag),
    index("teams_region_idx").on(t.region),
  ],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: teamRole("role").notNull().default("member"),

    /**
     * Marked to play, as opposed to carried as a substitute.
     *
     * Capped at five by the service rather than the schema, since "at most five
     * rows per team have this set" is not something a column can say. Starters
     * sort to the top of the roster and are preselected when a scrim needs a
     * lineup.
     */
    isStarter: boolean("is_starter").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One team per player.
    uniqueIndex("team_members_user_idx").on(t.userId),
    index("team_members_team_idx").on(t.teamId),
  ],
);

export const teamApplications = pgTable(
  "team_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    note: text("note"),
    status: applicationStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("team_applications_team_idx").on(t.teamId, t.status)],
);

/** A team advertising for practice. Scrims are always unrated. */
export const scrimListings = pgTable(
  "scrim_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    region: text("region").notNull(),
    note: text("note"),
    status: scrimListingStatus("status").notNull().default("open"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scrim_listings_region_idx").on(t.region, t.status)],
);

export const scrimRequests = pgTable(
  "scrim_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => scrimListings.id, { onDelete: "cascade" }),
    requestingTeamId: uuid("requesting_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    status: scrimRequestStatus("status").notNull().default("pending"),

    /**
     * The five each side is fielding, once its captain has said so.
     *
     * Null means not yet confirmed. A roster of exactly five is filled in on
     * acceptance, because there is nothing to choose.
     */
    hostLineup: uuid("host_lineup").array(),
    guestLineup: uuid("guest_lineup").array(),
    /** Both captains have this long to confirm before the scrim is dropped. */
    confirmDeadline: timestamp("confirm_deadline", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("scrim_requests_listing_idx").on(t.listingId, t.status)],
);
