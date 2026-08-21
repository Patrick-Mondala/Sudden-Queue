import { describe, expect, it } from "vitest";

import { DEFAULT_RATING, K_CALIBRATION, K_PLACEMENT, K_STEADY } from "../constants.js";
import {
  allowedGapForWait,
  applyMatchResult,
  expectedScore,
  isPlaced,
  kFactorForGamesPlayed,
  ratingDelta,
  teamAverageRating,
} from "./elo.js";
import {
  RATING_FLOOR,
  TIERS,
  TIER_FLOORS,
  isTierHigher,
  ratingToNextTier,
  tierForRating,
  tierIndex,
} from "./tiers.js";

describe("tier table", () => {
  it("has a floor for every tier", () => {
    expect(TIER_FLOORS).toHaveLength(TIERS.length);
    expect(TIERS).toHaveLength(21);
  });

  it("floors ascend strictly", () => {
    for (let i = 1; i < TIER_FLOORS.length; i += 1) {
      expect(TIER_FLOORS[i]).toBeGreaterThan(TIER_FLOORS[i - 1]);
    }
  });

  it("places a new player in the middle of the ladder", () => {
    // Start must sit mid-ladder so placements can move a player both ways.
    expect(tierForRating(DEFAULT_RATING)).toBe("B");

    const index = tierIndex("B");
    expect(index).toBeGreaterThan(TIERS.length * 0.35);
    expect(index).toBeLessThan(TIERS.length * 0.65);
  });

  it("maps boundaries exactly", () => {
    expect(tierForRating(620)).toBe("F-");
    expect(tierForRating(1169)).toBe("B-");
    expect(tierForRating(1170)).toBe("B");
    expect(tierForRating(1224)).toBe("B");
    expect(tierForRating(1225)).toBe("B+");
    expect(tierForRating(1445)).toBe("G-");
    expect(tierForRating(1610)).toBe("S-");
    expect(tierForRating(1720)).toBe("S+");
  });

  it("clamps outside the ladder", () => {
    expect(tierForRating(0)).toBe("F-");
    expect(tierForRating(-500)).toBe("F-");
    expect(tierForRating(99_999)).toBe("S+");
  });

  it("orders tiers", () => {
    expect(isTierHigher("S+", "S")).toBe(true);
    expect(isTierHigher("G-", "A+")).toBe(true);
    expect(isTierHigher("A+", "G-")).toBe(false);
    expect(isTierHigher("B", "B")).toBe(false);
  });

  it("reports distance to the next tier", () => {
    expect(ratingToNextTier(1170)).toBe(55);
    expect(ratingToNextTier(99_999)).toBeNull();
  });

  it("keeps the majority of the population in C and B", () => {
    // Design requirement: C- through B+ should span the bulk of the ladder's
    // occupied middle. Assert the band sits astride the starting rating.
    const cFloor = TIER_FLOORS[tierIndex("C-")];
    const bCeiling = TIER_FLOORS[tierIndex("A-")];
    expect(cFloor).toBeLessThan(DEFAULT_RATING);
    expect(bCeiling).toBeGreaterThan(DEFAULT_RATING);
  });
});

describe("expected score", () => {
  it("is even between equal ratings", () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 10);
  });

  it("favours the higher rating", () => {
    expect(expectedScore(1200, 1000)).toBeGreaterThan(0.5);
    expect(expectedScore(800, 1000)).toBeLessThan(0.5);
  });

  it("is symmetric", () => {
    expect(expectedScore(1200, 1000) + expectedScore(1000, 1200)).toBeCloseTo(1, 10);
  });

  it("gives ~0.91 across a 400-point gap", () => {
    expect(expectedScore(1400, 1000)).toBeCloseTo(0.909, 3);
  });
});

describe("rating delta", () => {
  it("is positive on a win and negative on a loss", () => {
    expect(ratingDelta(1000, 1000, 1, 24)).toBeGreaterThan(0);
    expect(ratingDelta(1000, 1000, 0, 24)).toBeLessThan(0);
  });

  it("pays more for an upset", () => {
    const upset = ratingDelta(800, 1200, 1, 24);
    const expected = ratingDelta(1000, 1000, 1, 24);
    expect(upset).toBeGreaterThan(expected);
  });

  it("moves half of K against an equal opponent", () => {
    expect(ratingDelta(1000, 1000, 1, 24)).toBe(12);
  });
});

describe("K schedule", () => {
  it("is conservative during placements, fastest during calibration", () => {
    expect(kFactorForGamesPlayed(0)).toBe(K_PLACEMENT);
    expect(kFactorForGamesPlayed(4)).toBe(K_PLACEMENT);
    expect(kFactorForGamesPlayed(5)).toBe(K_CALIBRATION);
    expect(kFactorForGamesPlayed(19)).toBe(K_CALIBRATION);
    expect(kFactorForGamesPlayed(20)).toBe(K_STEADY);
    expect(kFactorForGamesPlayed(500)).toBe(K_STEADY);
  });

  it("does not move a player faster during placements than afterwards", () => {
    // Five games is weak evidence. Placements seed a position; they do not sort.
    expect(K_PLACEMENT).toBeLessThan(K_CALIBRATION);
  });

  it("hides rank until placements are done", () => {
    expect(isPlaced(4)).toBe(false);
    expect(isPlaced(5)).toBe(true);
  });
});

describe("placement outcomes", () => {
  /** Plays `wins` wins then losses, always against an equal-rated opponent. */
  function simulatePlacements(wins: number): number {
    let rating = DEFAULT_RATING;
    for (let game = 0; game < 5; game += 1) {
      const won = game < wins;
      rating = applyMatchResult({
        playerRating: rating,
        gamesPlayed: game,
        opponentTeamRating: rating,
        won,
      }).ratingAfter;
    }
    return rating;
  }

  it("keeps a perfect placement run well short of the top tiers", () => {
    // A genuinely average player goes 5-0 about 3% of the time. Luck must not
    // be able to buy a rank that is supposed to mean semi-pro or pro.
    const tier = tierForRating(simulatePlacements(5));
    expect(tier).toBe("B+");
    expect(tierIndex(tier)).toBeLessThan(tierIndex("A-"));
  });

  it("keeps a winless placement run out of the bottom tiers", () => {
    expect(tierForRating(simulatePlacements(0))).toBe("B-");
  });

  it("spreads all placement outcomes across the middle three tiers only", () => {
    const tiers = [0, 1, 2, 3, 4, 5].map((w) => tierForRating(simulatePlacements(w)));
    expect(new Set(tiers)).toEqual(new Set(["B-", "B", "B+"]));
  });
});

describe("applying a result", () => {
  it("reports before, delta and after consistently", () => {
    const result = applyMatchResult({
      playerRating: 1200,
      gamesPlayed: 30,
      opponentTeamRating: 1200,
      won: true,
    });

    expect(result.ratingBefore).toBe(1200);
    expect(result.ratingAfter).toBe(1200 + result.ratingDelta);
  });

  it("never drops below the ladder floor, and reconciles the delta when clamped", () => {
    const result = applyMatchResult({
      playerRating: RATING_FLOOR,
      gamesPlayed: 30,
      opponentTeamRating: 2000,
      won: false,
    });

    expect(result.ratingAfter).toBe(RATING_FLOOR);
    // The delta must still explain the stored rating exactly, or dispute
    // reversal would drift.
    expect(result.ratingBefore + result.ratingDelta).toBe(result.ratingAfter);
  });
});

describe("team average", () => {
  it("averages and rounds", () => {
    expect(teamAverageRating([{ rating: 1000 }, { rating: 1101 }], DEFAULT_RATING)).toBe(1051);
  });

  it("falls back on an empty team", () => {
    expect(teamAverageRating([], DEFAULT_RATING)).toBe(DEFAULT_RATING);
  });
});

describe("search window", () => {
  it("starts narrow and widens with wait time", () => {
    expect(allowedGapForWait(0)).toBe(100);
    expect(allowedGapForWait(9)).toBe(100);
    expect(allowedGapForWait(10)).toBe(150);
    expect(allowedGapForWait(60)).toBe(400);
  });
});
