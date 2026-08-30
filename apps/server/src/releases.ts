import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseVersion } from "@suddenqueue/core";

/**
 * What version this deployment is currently serving.
 *
 * Read from the same `latest.json` the updater fetches, rather than from a
 * setting of its own. The alternative -- a SQ_MIN_CLIENT_VERSION beside the
 * released files -- is a second place for the answer to live, and the two would
 * eventually disagree: somebody uploads a release and forgets the variable, and
 * the floor silently stays where it was, which is the failure that makes a
 * required update optional again.
 *
 * The cost is that publishing is a cutover. The moment a new `latest.json`
 * lands, every older client is refused, and they cannot play until they have
 * restarted into the new one. That is the intent -- an update nobody is obliged
 * to take is not required -- but it does mean a release should be published
 * when somebody is around to notice if it is wrong.
 *
 * No directory, no file, or a file that does not parse means no floor at all.
 * A deployment that has never published cannot say what is current, and
 * refusing every client because a path is wrong would be a far worse failure
 * than admitting an old one.
 */
export type ReleaseFloor = {
  /** The version being served, or null when there is nothing to compare to. */
  current(): string | null;
};

/** How long a reading is trusted before the file is checked again. */
const RECHECK_MS = 5_000;

/**
 * Watches `latest.json` for the version it names.
 *
 * Polled by modification time rather than watched: the file is replaced by a
 * person copying files in, occasionally, and a stat every five seconds costs
 * nothing next to a filesystem watcher that has to survive the file being
 * replaced rather than written in place.
 */
export function createReleaseFloor(
  dir: string | null | undefined,
  { recheckMs = RECHECK_MS }: { recheckMs?: number } = {},
): ReleaseFloor {
  if (!dir) return { current: () => null };

  const path = join(dir, "latest.json");

  let version: string | null = null;
  let seenMtime = -1;
  let checkedAt = -Infinity;

  const reread = (): void => {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      // Gone, or never there. Forget what it used to say: a deployment that
      // has removed its manifest is not still entitled to the floor it named.
      version = null;
      seenMtime = -1;
      return;
    }

    if (mtime === seenMtime) return;
    seenMtime = mtime;

    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const named = (parsed as { version?: unknown })?.version;
      version = typeof named === "string" && parseVersion(named) ? named : null;
    } catch {
      // Half-written, or not JSON. A copy in progress looks exactly like this,
      // so it is worth nothing more than waiting for the next check.
      version = null;
    }
  };

  return {
    current() {
      const now = Date.now();
      if (now - checkedAt >= recheckMs) {
        checkedAt = now;
        reread();
      }
      return version;
    },
  };
}
