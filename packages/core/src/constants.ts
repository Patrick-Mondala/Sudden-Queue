/**
 * Server-side constants.
 *
 * Ported from the earlier system, retuned for team play and for a coordinator
 * that cannot reserve servers or observe results.
 *
 * Split by what a deployment may change. The values below describe the *tool* --
 * how long an accept window runs, how fast the search widens -- and are tuning
 * rather than game shape, so they stay compiled in. Anything describing a
 * particular *game* lives in config.ts and comes from the environment.
 */
import { gameConfig } from "./config.js";

/** Match composition. Configurable: see SQ_TEAM_SIZE. */
export const TEAM_SIZE = gameConfig.teamSize;
export const MATCH_SIZE = gameConfig.matchSize;

/**
 * Roster limits for a registered team.
 *
 * Bigger than a match on purpose: a team fields five but carries substitutes,
 * and a roster capped at exactly five would mean dropping someone to trial
 * anyone new.
 */
export const MAX_TEAM_SIZE = gameConfig.maxTeamSize;
export const TEAM_TAG_MAX_LENGTH = 4;
export const TEAM_NAME_MAX_LENGTH = 24;
export const TEAM_APPLICATION_NOTE_MAX_LENGTH = 200;
export const MAX_PARTY_SIZE = gameConfig.maxPartySize;

/**
 * Queueable regions.
 *
 * A plain string array rather than a literal union now that a deployment picks
 * them: the set is not known until the process starts, so the type cannot
 * enumerate it. Routes validate against this list instead.
 */
export const REGIONS: readonly string[] = gameConfig.regions.map((r) => r.id);
export type Region = string;

export const QUEUE_TYPES = ["PUG", "SCRIM"] as const;
export type QueueType = (typeof QUEUE_TYPES)[number];

/**
 * Rating. The ladder centres on DEFAULT_RATING so placements have room to move
 * a player in both directions — see rating/tiers.ts for the threshold table.
 */
export const DEFAULT_RATING = gameConfig.defaultRating;

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

/**
 * How long a clean run has to be before the escalation resets.
 *
 * Without this the schedule is a life sentence: one miss a year apart would
 * still walk someone up to an hour. What it punishes is a bad session, not a
 * bad record.
 */
export const MISSED_ACCEPT_DECAY_SECONDS = 24 * 60 * 60;

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

/**
 * Chat is not saved.
 *
 * Each channel keeps a bounded buffer in memory for the life of the process,
 * which is roughly the life of the thing being talked about -- a party, or a
 * match. Nothing is written down, so there is no retention question and no
 * moderation surface nobody asked for.
 */
export const CHAT_MAX_MESSAGE_LENGTH = 200;
export const CHAT_MAX_STORED_MESSAGES = 100;

/** A burst allowance, so one person cannot fill the window on their own. */
/**
 * How long a captain has to field a side once a scrim is agreed.
 *
 * Short on purpose: the roster is already on screen with five preselected, so
 * confirming is a click unless they want to change it, and a half-arranged
 * scrim should not sit on the board while someone is away.
 */
export const SCRIM_LINEUP_SECONDS = 30;

/**
 * The backstop on everything else that writes: teams, applications, scrim
 * listings and requests.
 *
 * Generous by design. None of these is expensive and none is something a
 * person does twice a second, so the limit is set where a human never reaches
 * it and a script does immediately.
 */
export const WRITE_RATE_LIMIT = 60;
export const WRITE_RATE_WINDOW_SECONDS = 60;

export const CHAT_RATE_LIMIT = 5;
export const CHAT_RATE_WINDOW_SECONDS = 5;
