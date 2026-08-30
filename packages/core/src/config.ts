/**
 * Deployment configuration.
 *
 * Sudden Queue is meant to be run by whoever needs it, for whatever game needs
 * it, so the handful of values that describe *a game* rather than *the tool*
 * are read from the environment here and everything else derives from them.
 * The defaults are a 5v5 shooter, which is what the first deployment is.
 *
 * Read once, at module load. That is deliberate: these decide the shape of a
 * match, and a value that could change while a match is mid-flight would be a
 * source of bugs nobody could reproduce. Restart to change them.
 *
 * The client never imports this. It cannot -- a shipped desktop binary has no
 * access to the server's environment -- so it asks `GET /config` instead and
 * renders whatever it is told. That keeps one source of truth on the server.
 */

/** A queueable region: the id stored on tickets, plus how to show it. */
export interface RegionOption {
  /** Stored and matched on. Lowercase, no spaces. */
  id: string;
  /** Short form for buttons, e.g. "NA". */
  label: string;
  /** Full name for tooltips, e.g. "North America". */
  name: string;
}

/** Everything a deployment may change without touching code. */
export interface GameConfig {
  /** What the tool calls itself. */
  appName: string;
  /** The game it is being run for, shown to players. */
  gameName: string;
  /** Players a side. */
  teamSize: number;
  /** Players in a whole match. Always twice the team size. */
  matchSize: number;
  /** Largest group that may queue together. */
  maxPartySize: number;
  /** Largest registered team roster, substitutes included. */
  maxTeamSize: number;
  regions: RegionOption[];
  /** Rank names, weakest first. */
  tiers: string[];
  /** Rating at which each rank begins. Index-aligned with `tiers`. */
  tierFloors: number[];
  /** Where an unrated player starts. */
  defaultRating: number;
  /** Games before a rank is shown at all. */
  placementGames: number;
}

const DEFAULT_REGIONS: RegionOption[] = [
  { id: "na", label: "NA", name: "North America" },
  { id: "sa", label: "SA", name: "South America" },
  { id: "eu", label: "EU", name: "Europe" },
  { id: "asia", label: "ASIA", name: "Asia" },
];

const DEFAULT_TIERS = [
  "F-", "F", "F+",
  "D-", "D", "D+",
  "C-", "C", "C+",
  "B-", "B", "B+",
  "A-", "A", "A+",
  "G-", "G", "G+",
  "S-", "S", "S+",
];

const DEFAULT_TIER_FLOORS = [
  620, 675, 730,
  785, 840, 895,
  950, 1005, 1060,
  1115, 1170, 1225,
  1280, 1335, 1390,
  1445, 1500, 1555,
  1610, 1665, 1720,
];

/** Environment, where there is one. Absent in a browser bundle. */
function env(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

function fail(name: string, why: string): never {
  // Thrown at import, so a bad value stops the process at boot rather than
  // surfacing later as a match of the wrong size.
  throw new Error(`${name} is invalid: ${why}`);
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) fail(name, `expected a whole number, got "${raw}"`);
  if (value < min || value > max) fail(name, `expected ${min}-${max}, got ${value}`);
  return value;
}

/** `na:North America,eu:Europe` — the label is derived from the id. */
function readRegions(name: string, fallback: RegionOption[]): RegionOption[] {
  const raw = env(name);
  if (raw === undefined) return fallback;

  const regions = raw.split(",").map((entry) => {
    const [id, full] = entry.split(":");
    const trimmed = (id ?? "").trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(trimmed)) {
      fail(name, `"${entry}" has no usable id (expected "na:North America")`);
    }
    return { id: trimmed, label: trimmed.toUpperCase(), name: (full ?? trimmed).trim() };
  });

  if (regions.length === 0) fail(name, "at least one region is required");
  if (new Set(regions.map((r) => r.id)).size !== regions.length) {
    fail(name, "region ids must be unique");
  }
  return regions;
}

function readList(name: string, fallback: string[]): string[] {
  const raw = env(name);
  if (raw === undefined) return fallback;

  const items = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length === 0) fail(name, "at least one entry is required");
  return items;
}

function readNumberList(name: string, fallback: number[]): number[] {
  const raw = env(name);
  if (raw === undefined) return fallback;

  const items = readList(name, []).map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) fail(name, `"${s}" is not a number`);
    return n;
  });
  return items;
}

function load(): GameConfig {
  const teamSize = readInt("SQ_TEAM_SIZE", 5, 1, 32);
  const tiers = readList("SQ_TIERS", DEFAULT_TIERS);
  const tierFloors = readNumberList("SQ_TIER_FLOORS", DEFAULT_TIER_FLOORS);

  if (tiers.length !== tierFloors.length) {
    fail(
      "SQ_TIER_FLOORS",
      `${tierFloors.length} floors for ${tiers.length} tiers; they are index-aligned so the counts must match`,
    );
  }
  for (let i = 1; i < tierFloors.length; i += 1) {
    if (tierFloors[i]! <= tierFloors[i - 1]!) {
      // Otherwise a rating maps to two ranks and the ladder stops being an order.
      fail("SQ_TIER_FLOORS", "floors must increase, lowest rank first");
    }
  }

  const maxPartySize = readInt("SQ_MAX_PARTY_SIZE", teamSize, 1, teamSize);
  const maxTeamSize = readInt("SQ_MAX_TEAM_SIZE", Math.max(10, teamSize * 2), teamSize, 128);

  return {
    appName: env("SQ_APP_NAME") ?? "Sudden Queue",
    gameName: env("SQ_GAME_NAME") ?? "Sudden Attack Zero Point",
    teamSize,
    matchSize: teamSize * 2,
    maxPartySize,
    maxTeamSize,
    regions: readRegions("SQ_REGIONS", DEFAULT_REGIONS),
    tiers,
    tierFloors,
    defaultRating: readInt("SQ_DEFAULT_RATING", 1200, 1, 100_000),
    placementGames: readInt("SQ_PLACEMENT_GAMES", 5, 1, 1_000),
  };
}

/** The configuration this process is running with. */
export const gameConfig: GameConfig = load();

/** Re-reads the environment. Only for tests; nothing else should call it. */
export function reloadGameConfigForTests(): GameConfig {
  return load();
}
