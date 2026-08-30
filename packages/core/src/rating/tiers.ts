/**
 * Tier table — the visible rank derived from hidden rating.
 *
 * Replaces the earlier rank table (8 named ranks on fixed MMR thresholds,
 * plus a positional Challenger rank) with 21 letter tiers on fixed thresholds.
 *
 * Calibrated for a 1200 starting rating and an assumed population spread of
 * ~180 points, at 55 points per tier. That places the median player in B, puts
 * roughly 59% of the population across C and B, and leaves the tails rare on
 * both ends: F- is as scarce as S+.
 *
 * IMPORTANT: tier is always DERIVED from rating, never stored. The 180-point
 * spread is an estimate — real spread depends on the population and on how much
 * 5v5 team noise compresses individual ratings. When we recalibrate against real
 * data, this file changes and nothing needs migrating.
 */

import { gameConfig } from "../config.js";

export const TIERS: readonly string[] = gameConfig.tiers;

/**
 * A rank name.
 *
 * Not a literal union any more: the names come from configuration, so they are
 * not known at compile time. Little is lost -- every payload already carried
 * this as a nullable string, and it is the floors table rather than the type
 * that guarantees a rating maps to exactly one rank.
 */
export type Tier = string;

/** Rating at which each tier begins. Index-aligned with TIERS. */
export const TIER_FLOORS: readonly number[] = gameConfig.tierFloors;

/** Broad bands, for copy and colour grouping. */
export const TIER_BANDS = {
  "F": "New",
  "D": "Learning",
  "C": "Average",
  "B": "Above average",
  "A": "Strong",
  "G": "Semi-professional",
  "S": "Professional",
} as const;

export const TIER_COLORS: Record<string, string> = {
  F: "#7C8794",
  D: "#9AA5B1",
  C: "#5DBE7B",
  B: "#2FC8BF",
  A: "#C77DFF",
  G: "#FF5C8A",
  S: "#F2A93B",
};

/** The letter of a tier, ignoring the +/- suffix. */
export function tierLetter(tier: Tier): string {
  return tier.charAt(0);
}

export function tierColor(tier: Tier): string {
  return TIER_COLORS[tierLetter(tier)] ?? TIER_COLORS.F;
}

export function tierBand(tier: Tier): string {
  return TIER_BANDS[tierLetter(tier) as keyof typeof TIER_BANDS] ?? "New";
}

/**
 * The visible tier for a rating. Ratings below the floor clamp to F-, which is
 * also the rating floor enforced on application.
 */
export function tierForRating(rating: number): Tier {
  let index = 0;

  for (let i = TIER_FLOORS.length - 1; i >= 0; i -= 1) {
    if (rating >= TIER_FLOORS[i]) {
      index = i;
      break;
    }
  }

  return TIERS[index];
}

/** Ordinal position, F- = 0 through S+ = 20. Useful for comparisons. */
export function tierIndex(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export function isTierHigher(candidate: Tier, existing: Tier): boolean {
  return tierIndex(candidate) > tierIndex(existing);
}

/** Rating needed to reach the next tier, or null at S+. */
export function ratingToNextTier(rating: number): number | null {
  const current = tierIndex(tierForRating(rating));
  if (current >= TIERS.length - 1) return null;
  return TIER_FLOORS[current + 1] - rating;
}

/** Lowest rating the ladder allows. */
export const RATING_FLOOR = TIER_FLOORS[0];
