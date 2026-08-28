import type { SessionUser } from "./sessions.js";

/**
 * Game Masters.
 *
 * One privileged rank in the product, two values in the enum: `admin` outranks
 * `game_master` and is reserved for whatever needs it later, but for anything a
 * GM does today the two are the same. Asking "is this a GM" in one place keeps
 * every route from having to remember that.
 */
export type Role = SessionUser["role"];

export function isGameMaster(role: Role): boolean {
  return role === "game_master" || role === "admin";
}

/** The prefix shown wherever a Game Master's name appears. */
export const GAME_MASTER_TAG = "GM";
