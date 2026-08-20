import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["player", "moderator", "admin"]);

/**
 * Accounts. Identity comes from Discord OAuth; `sazpName` is the in-game name
 * the player types themselves.
 *
 * There is no way to verify `sazpName` against Sudden Attack, so it is display
 * data with a trust cost, not an identity. Moderators can override it.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordId: text("discord_id").notNull(),
    discordName: text("discord_name").notNull(),
    avatarUrl: text("avatar_url"),
    sazpName: text("sazp_name"),
    role: userRole("role").notNull().default("player"),

    /** Set by a moderator; blocks queueing while in the future. */
    bannedUntil: timestamp("banned_until", { withTimezone: true }),
    banReason: text("ban_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_discord_id_idx").on(t.discordId)],
);

/**
 * Rating state, one row per user.
 *
 * Deliberately has no tier column. Tier is a pure function of rating
 * (see @sazp/core tierForRating), so recalibrating the thresholds against real
 * population data is a constants change rather than a migration.
 */
export const playerRatings = pgTable(
  "player_ratings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),

    rating: integer("rating").notNull(),
    peakRating: integer("peak_rating").notNull(),

    /** Drives the K-factor schedule and whether a rank is shown at all. */
    gamesPlayed: integer("games_played").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    currentWinStreak: integer("current_win_streak").notNull().default(0),
    longestWinStreak: integer("longest_win_streak").notNull().default(0),

    /** Reliability counters, surfaced on the public profile. */
    missedAccepts: integer("missed_accepts").notNull().default(0),
    abandons: integer("abandons").notNull().default(0),
    disputesInvolved: integer("disputes_involved").notNull().default(0),

    /** Set while serving a missed-accept cooldown. */
    queueCooldownUntil: timestamp("queue_cooldown_until", { withTimezone: true }),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Ladder ordering. Unplaced players are excluded at query time, not here,
    // so the index stays useful for both cases.
    index("player_ratings_rating_idx").on(t.rating),
  ],
);

/** Server-side sessions issued after the Discord OAuth exchange. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_idx").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
  ],
);
