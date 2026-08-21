/**
 * Shared configuration for server and client.
 *
 * Ported from the earlier system, retuned for 5v5 and for a coordinator
 * that cannot reserve servers or observe results.
 */

/** Match composition. The earlier system was 3v3; Sudden Queue targets 5v5. */
export const TEAM_SIZE = 5;
export const MATCH_SIZE = TEAM_SIZE * 2;
export const MAX_PARTY_SIZE = 5;

export const REGIONS = ["na", "sa", "eu", "asia"] as const;
export type Region = (typeof REGIONS)[number];

export const QUEUE_TYPES = ["PUG", "SCRIM"] as const;
export type QueueType = (typeof QUEUE_TYPES)[number];

/**
 * Rating. The ladder centres on DEFAULT_RATING so placements have room to move
 * a player in both directions — see rating/tiers.ts for the threshold table.
 */
export const DEFAULT_RATING = 1200;

/**
 * K-factor schedule. Placements are deliberately conservative: five games is
 * weak evidence (an average player goes 5-0 roughly 3% of the time), so a lucky
 * run must not land anyone near the top tiers. The real sorting happens during
 * the calibration window, where there is actually signal.
 */
export const PLACEMENT_GAMES = 5;
export const CALIBRATION_GAMES = 20;
export const K_PLACEMENT = 24;
export const K_CALIBRATION = 40;
export const K_STEADY = 24;

/** Flat extra deduction on top of the Elo loss for abandoning a match. */
export const ABANDON_RATING_PENALTY = 75;

/**
 * Matchmaking search window. Starts narrow around the party's rating and widens
 * with wait time, trading match quality for speed.
 */
export const MATCHMAKING_INITIAL_WINDOW = 100;
export const MATCHMAKING_WINDOW_GROWTH = 50;
export const MATCHMAKING_WINDOW_GROWTH_SECONDS = 10;

/** How often the matchmaker sweeps the queue, and its per-pass output cap. */
export const MATCHMAKING_INTERVAL_MS = 2_000;
export const MAX_MATCHES_PER_TICK = 10;

/**
 * Match lifecycle deadlines. Every transition gets one — without them a single
 * player who closes the app silently freezes nine others out of the queue.
 */
export const ACCEPT_WINDOW_SECONDS = 20;
export const PARTY_UP_SECONDS = 120;
export const REPORT_WINDOW_SECONDS = 60 * 30;

/** Escalating cooldowns for missing an accept, by recent offence count. */
export const MISSED_ACCEPT_COOLDOWNS_SECONDS = [300, 900, 1_800, 3_600];

/** A queue ticket whose client has gone quiet this long is treated as gone. */
export const QUEUE_HEARTBEAT_INTERVAL_SECONDS = 5;
export const QUEUE_STALE_AFTER_SECONDS = 20;

/**
 * How long a disconnected player keeps their place in a party.
 *
 * Longer than the queue's window on purpose. A dropped socket is usually a
 * blip, and the client reconnects with backoff; being turfed out of a
 * five-stack because a router hiccuped would be worse than the stale roster
 * this avoids. The queue can afford to be twitchier because leaving it costs
 * nothing but a re-queue.
 */
export const PARTY_DISCONNECT_GRACE_SECONDS = 90;

/** Party invites auto-expire. */
export const INVITE_EXPIRATION_SECONDS = 30;

/**
 * Invite throttling.
 *
 * Two separate limits, because they stop two different things. The window caps
 * how fast one player can work through a list of everyone online; the repeat
 * cooldown stops one person being invited over and over by the same player,
 * which the window alone would allow.
 *
 * The cooldown is longer than the expiry on purpose: an invite that lapses
 * unanswered should stay unanswered for a while rather than reappearing the
 * moment it clears.
 */
export const INVITE_RATE_LIMIT = 10;
export const INVITE_RATE_WINDOW_SECONDS = 60;
export const INVITE_REPEAT_COOLDOWN_SECONDS = 60;

export const CHAT_MAX_MESSAGE_LENGTH = 200;
export const CHAT_MAX_STORED_MESSAGES = 100;
