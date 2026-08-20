/**
 * Elo — ported from the earlier system's rating maths.
 *
 * The expected-score formula is unchanged textbook Elo (the same system chess
 * uses); what changes here is the K-factor, which is now a three-stage schedule
 * rather than a single constant, and the search-window ramp which is unchanged.
 *
 * Elo is a 1v1 system. Applied to 5v5 we compare team averages and give every
 * player on a side the same delta — standard, and unable to distinguish a carry
 * from a passenger. With no per-player match data (no kills, no damage, just a
 * captain's word) there is nothing better to attribute with. If that ever
 * changes, Glicko-2 is the natural upgrade.
 */

import {
  CALIBRATION_GAMES,
  K_CALIBRATION,
  K_PLACEMENT,
  K_STEADY,
  MATCHMAKING_INITIAL_WINDOW,
  MATCHMAKING_WINDOW_GROWTH,
  MATCHMAKING_WINDOW_GROWTH_SECONDS,
  PLACEMENT_GAMES,
} from "../constants.js";
import { RATING_FLOOR } from "./tiers.js";

/** Probability that a player rated `a` beats a player rated `b`. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/**
 * K-factor for a player's next match, by how many rated games they have played.
 *
 * Placements move a player less than the steady ladder does, not more. Five
 * games is weak evidence, so placements only seed a rough starting position;
 * the calibration window that follows is where genuine skill separates.
 */
export function kFactorForGamesPlayed(gamesPlayed: number): number {
  if (gamesPlayed < PLACEMENT_GAMES) return K_PLACEMENT;
  if (gamesPlayed < CALIBRATION_GAMES) return K_CALIBRATION;
  return K_STEADY;
}

/** A player is unranked until they finish placements. */
export function isPlaced(gamesPlayed: number): boolean {
  return gamesPlayed >= PLACEMENT_GAMES;
}

export function placementGamesRemaining(gamesPlayed: number): number {
  return Math.max(0, PLACEMENT_GAMES - gamesPlayed);
}

/**
 * Rating change for one result. `actualScore` is 1 for a win, 0 for a loss.
 * Rounds half-up to an integer, matching the earlier implementation.
 */
export function ratingDelta(
  playerRating: number,
  opponentRating: number,
  actualScore: number,
  kFactor: number,
): number {
  const expected = expectedScore(playerRating, opponentRating);
  return Math.floor(kFactor * (actualScore - expected) + 0.5);
}

/** Weighted mean rating across a team. */
export function teamAverageRating(
  members: readonly { rating: number }[],
  fallback: number,
): number {
  if (members.length === 0) return fallback;
  const total = members.reduce((sum, m) => sum + m.rating, 0);
  return Math.floor(total / members.length + 0.5);
}

export interface AppliedRating {
  ratingBefore: number;
  ratingDelta: number;
  ratingAfter: number;
}

/**
 * Computes the rating change for one player in a finished match.
 *
 * Returns before/delta/after rather than just the new value: both the delta and
 * the pre-match rating get persisted per participant, so a mod overturning a
 * disputed result later is exact arithmetic instead of a recomputation.
 */
export function applyMatchResult(params: {
  playerRating: number;
  gamesPlayed: number;
  opponentTeamRating: number;
  won: boolean;
  abandoned?: boolean;
  abandonPenalty?: number;
}): AppliedRating {
  const {
    playerRating,
    gamesPlayed,
    opponentTeamRating,
    won,
    abandoned = false,
    abandonPenalty = 0,
  } = params;

  const k = kFactorForGamesPlayed(gamesPlayed);
  let delta = ratingDelta(playerRating, opponentTeamRating, won ? 1 : 0, k);

  if (abandoned) delta -= abandonPenalty;

  const after = Math.max(RATING_FLOOR, playerRating + delta);

  return {
    ratingBefore: playerRating,
    // Re-derive so the delta always reconciles with the clamped result.
    ratingDelta: after - playerRating,
    ratingAfter: after,
  };
}

/**
 * Maximum rating gap the matchmaker will tolerate for a candidate match, given
 * how long the longest-waiting party has been queued. Carried over unchanged.
 */
export function allowedGapForWait(waitSeconds: number): number {
  const steps = Math.floor(waitSeconds / MATCHMAKING_WINDOW_GROWTH_SECONDS);
  return MATCHMAKING_INITIAL_WINDOW + steps * MATCHMAKING_WINDOW_GROWTH;
}
