import { afterEach, describe, expect, it } from "vitest";

import { gameConfig, reloadGameConfigForTests } from "./config.js";

/**
 * The live config is read once at import, so these set the environment and ask
 * for a re-read rather than expecting the module to notice on its own.
 */
const KEYS = [
  "SQ_APP_NAME", "SQ_GAME_NAME", "SQ_TEAM_SIZE", "SQ_MAX_PARTY_SIZE",
  "SQ_MAX_TEAM_SIZE", "SQ_REGIONS", "SQ_TIERS", "SQ_TIER_FLOORS",
  "SQ_DEFAULT_RATING", "SQ_PLACEMENT_GAMES",
];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

const withEnv = (env: Record<string, string>) => {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return reloadGameConfigForTests();
};

describe("the defaults", () => {
  it("are the 5v5 shape the first deployment runs", () => {
    // An unconfigured checkout has to work; nobody reads the docs first.
    expect(gameConfig.teamSize).toBe(5);
    expect(gameConfig.matchSize).toBe(10);
    expect(gameConfig.maxPartySize).toBe(5);
    expect(gameConfig.regions.map((r) => r.id)).toEqual(["na", "sa", "eu", "asia"]);
    expect(gameConfig.tiers).toHaveLength(21);
    expect(gameConfig.tierFloors).toHaveLength(21);
    expect(gameConfig.defaultRating).toBe(1200);
  });
});

describe("changing the shape of a match", () => {
  it("takes the team size and derives the match size from it", async () => {
    const c = withEnv({ SQ_TEAM_SIZE: "3" });

    expect(c.teamSize).toBe(3);
    // Never configured separately: two teams is what a match is.
    expect(c.matchSize).toBe(6);
  });

  it("keeps a party from being larger than a team", async () => {
    // A party of six could never be matched into a team of five, so the
    // ceiling follows the team rather than standing on its own.
    expect(() => withEnv({ SQ_TEAM_SIZE: "5", SQ_MAX_PARTY_SIZE: "6" })).toThrow(/1-5/);
  });

  it("defaults the party ceiling to a full team", async () => {
    expect(withEnv({ SQ_TEAM_SIZE: "3" }).maxPartySize).toBe(3);
  });

  it("refuses a size that is not a whole number", async () => {
    expect(() => withEnv({ SQ_TEAM_SIZE: "four" })).toThrow(/whole number/);
    expect(() => withEnv({ SQ_TEAM_SIZE: "2.5" })).toThrow(/whole number/);
  });

  it("refuses a team of nobody", async () => {
    expect(() => withEnv({ SQ_TEAM_SIZE: "0" })).toThrow(/1-32/);
  });
});

describe("regions", () => {
  it("takes ids and names, and derives the short label", async () => {
    const c = withEnv({ SQ_REGIONS: "oce:Oceania,eu:Europe" });

    expect(c.regions).toEqual([
      { id: "oce", label: "OCE", name: "Oceania" },
      { id: "eu", label: "EU", name: "Europe" },
    ]);
  });

  it("falls back to the id when no name is given", async () => {
    expect(withEnv({ SQ_REGIONS: "oce" }).regions[0]).toEqual({
      id: "oce",
      label: "OCE",
      name: "oce",
    });
  });

  it("refuses duplicates, which would split a queue in two", async () => {
    expect(() => withEnv({ SQ_REGIONS: "eu:Europe,eu:Also Europe" })).toThrow(/unique/);
  });

  it("refuses an id that could not be stored or matched on", async () => {
    expect(() => withEnv({ SQ_REGIONS: "West Europe" })).toThrow(/no usable id/);
  });

  it("treats a blank setting as unset rather than as no regions", async () => {
    // Consistent with every other key: blank means "I did not set this". A
    // deployment with no regions could not queue anyone, so it is never a
    // reading worth honouring.
    expect(withEnv({ SQ_REGIONS: "   " }).regions).toHaveLength(4);
  });

  it("refuses a list that is punctuation and nothing else", async () => {
    expect(() => withEnv({ SQ_REGIONS: ",," })).toThrow(/no usable id/);
  });
});

describe("ranks", () => {
  it("takes names and floors together", async () => {
    const c = withEnv({
      SQ_TIERS: "Bronze,Silver,Gold",
      SQ_TIER_FLOORS: "0,1000,2000",
    });

    expect(c.tiers).toEqual(["Bronze", "Silver", "Gold"]);
    expect(c.tierFloors).toEqual([0, 1000, 2000]);
  });

  it("refuses a count mismatch, since the two are index-aligned", async () => {
    expect(() =>
      withEnv({ SQ_TIERS: "Bronze,Silver,Gold", SQ_TIER_FLOORS: "0,1000" }),
    ).toThrow(/index-aligned/);
  });

  it("refuses floors that do not increase", async () => {
    // Otherwise one rating maps to two ranks and the ladder stops being an order.
    expect(() =>
      withEnv({ SQ_TIERS: "Bronze,Silver,Gold", SQ_TIER_FLOORS: "0,2000,1000" }),
    ).toThrow(/must increase/);
  });

  it("refuses a floor that is not a number", async () => {
    expect(() =>
      withEnv({ SQ_TIERS: "Bronze,Silver", SQ_TIER_FLOORS: "0,high" }),
    ).toThrow(/not a number/);
  });
});

describe("branding", () => {
  it("takes the name of the tool and the game it is run for", async () => {
    const c = withEnv({ SQ_APP_NAME: "Rocket Queue", SQ_GAME_NAME: "Rocket League" });

    expect(c.appName).toBe("Rocket Queue");
    expect(c.gameName).toBe("Rocket League");
  });

  it("ignores a blank value rather than showing an empty name", async () => {
    expect(withEnv({ SQ_APP_NAME: "   " }).appName).toBe("Sudden Queue");
  });
});
