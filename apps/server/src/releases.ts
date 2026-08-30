import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

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
 * to take is not required -- but it is also why the manifest alone is not
 * enough to raise the floor. See below.
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

/** Reads `SHA256SUMS`, in the format `sha256sum` writes and `-c` reads. */
function readSums(path: string): Map<string, string> {
  const sums = new Map<string, string>();

  for (const line of readFileSync(path, "utf8").split("\n")) {
    // "<64 hex>  <name>", two spaces, or " *" for the binary marker.
    const match = /^([0-9a-f]{64})\s[\s*](.+?)\s*$/i.exec(line);
    if (match) sums.set(match[2], match[1].toLowerCase());
  }

  return sums;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Watches `latest.json` for the version it names, and refuses to believe it
 * until the installer it points at is really there.
 *
 * The check exists because of what raising the floor does. A manifest naming
 * 0.2.0 locks out every 0.1.x the moment it lands, and the only way back in is
 * to download 0.2.0 -- so if the file it names is missing, half-copied, or a
 * different build than the one that was signed, every player is shut out of an
 * app that cannot fetch the thing that would let them back. Copying two files
 * in the wrong order is an easy mistake and an expensive one.
 *
 * So the floor rises only when the bytes on disk hash to what `SHA256SUMS`
 * says they should. Until then this deployment reports no floor and keeps
 * serving whoever it was already serving, which is the harmless failure.
 *
 * This is an integrity check and not an authenticity one. Anyone who can write
 * to the releases directory can rewrite both files; what stops them mattering
 * is the minisign signature the updater checks before it runs an installer.
 * What this catches is a truncated copy, a half-finished upload, and a
 * manifest that arrived before its installer did.
 *
 * Polled by modification time rather than watched: the files are replaced by a
 * person copying them in, occasionally, and a stat every five seconds costs
 * nothing next to a watcher that has to survive files being replaced rather
 * than written in place. A failed verification is deliberately not cached
 * against the manifest's mtime -- the installer landing a minute later changes
 * nothing about `latest.json`, and a floor that stayed off until the next
 * publish would be a required update quietly made optional.
 */
export function createReleaseFloor(
  dir: string | null | undefined,
  {
    recheckMs = RECHECK_MS,
    onProblem,
  }: { recheckMs?: number; onProblem?: (problem: string) => void } = {},
): ReleaseFloor {
  if (!dir) return { current: () => null };

  const manifestPath = join(dir, "latest.json");
  const sumsPath = join(dir, "SHA256SUMS");

  let version: string | null = null;
  let seenMtime = -1;
  let checkedAt = -Infinity;
  let lastProblem: string | null = null;

  /** Says why the floor is not rising, once per distinct reason. */
  const problem = (message: string): null => {
    if (message !== lastProblem) {
      lastProblem = message;
      onProblem?.(message);
    }
    version = null;
    return null;
  };

  const verified = (named: string): string | null => {
    lastProblem = null;
    version = named;
    return named;
  };

  const reread = (): void => {
    let mtime: number;
    try {
      mtime = statSync(manifestPath).mtimeMs;
    } catch {
      // Gone, or never there. Forget what it used to say: a deployment that
      // has removed its manifest is not still entitled to the floor it named.
      version = null;
      lastProblem = null;
      seenMtime = -1;
      return;
    }

    // An unchanged manifest that verified last time needs no further work. One
    // that did not is checked again, because what it was waiting for is a file
    // whose arrival does not touch the manifest at all.
    if (mtime === seenMtime && version !== null) return;
    seenMtime = mtime;

    let manifest: { version?: unknown; platforms?: Record<string, { url?: unknown }> };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      // A copy in progress looks exactly like this.
      problem("latest.json is not readable as JSON yet");
      return;
    }

    const named = manifest?.version;
    if (typeof named !== "string" || !parseVersion(named)) {
      problem("latest.json names no usable version");
      return;
    }

    const url = manifest?.platforms?.["windows-x86_64"]?.url;
    if (typeof url !== "string") {
      problem(`latest.json ${named} names no installer to check`);
      return;
    }

    // The manifest carries a url; what is on disk is its last segment, which
    // is how the file arrives when it is copied across from the release.
    const installer = decodeURIComponent(basename(url));
    const installerPath = join(dir, installer);

    let sums: Map<string, string>;
    try {
      sums = readSums(sumsPath);
    } catch {
      problem(`SHA256SUMS is missing, so ${installer} cannot be checked`);
      return;
    }

    const expected = sums.get(installer);
    if (!expected) {
      problem(`SHA256SUMS does not list ${installer}`);
      return;
    }

    let actual: string;
    try {
      actual = sha256(installerPath);
    } catch {
      problem(`${installer} is not in the releases directory yet`);
      return;
    }

    if (actual !== expected) {
      problem(
        `${installer} does not match SHA256SUMS (expected ${expected.slice(0, 12)}…, ` +
          `found ${actual.slice(0, 12)}…). Not raising the floor to ${named}.`,
      );
      return;
    }

    verified(named);
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
