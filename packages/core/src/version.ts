/**
 * Version comparison.
 *
 * Shared because both sides have to reach the same answer. The server decides
 * whether a client is too old to serve; the client decides whether the version
 * it was offered is newer than the one it is running. Two implementations of
 * "is this older" that disagreed by one edge case would refuse builds that are
 * fine, or admit builds that are not.
 *
 * Semver as far as this project uses it: three numbers and an optional
 * prerelease tag. The one rule worth implementing rather than assuming is that
 * a prerelease sorts *below* the release of the same numbers -- 0.2.0-rc.1 is
 * older than 0.2.0 -- because the obvious string comparison gets that backwards
 * and would let a release candidate satisfy a floor its final never could.
 */

export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers after the `-`, or null for a plain release. */
  prerelease: string[] | null;
};

const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Reads a version string, or null if it is not one.
 *
 * Null rather than a throw or a zero: "unparseable" is a real answer the
 * callers act on, and a version that silently became 0.0.0 would compare as
 * older than everything, which is the most dangerous possible guess.
 *
 * Build metadata after `+` is accepted and discarded -- semver says it takes no
 * part in ordering, so two versions differing only there are the same version.
 */
export function parseVersion(value: string): ParsedVersion | null {
  const match = PATTERN.exec(String(value ?? "").trim());
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

/** Orders two prerelease identifier lists. Numbers below strings, as specified. */
function comparePrerelease(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    // A shorter list of otherwise equal identifiers is the smaller version:
    // 1.0.0-rc precedes 1.0.0-rc.1.
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;

    const na = /^\d+$/.test(a[i]) ? Number(a[i]) : null;
    const nb = /^\d+$/.test(b[i]) ? Number(b[i]) : null;

    if (na !== null && nb !== null) return na < nb ? -1 : 1;
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * -1, 0 or 1 for a before b, same, a after b. Null if either is unparseable.
 *
 * The null is why this does not return a plain number: a caller that treated an
 * unreadable version as "equal" would let anything through, and one that
 * treated it as "older" would refuse a client over a typo in a header.
 * Deciding which of those is right belongs to the caller.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  for (const part of ["major", "minor", "patch"] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }

  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && right.prerelease) {
    const order = comparePrerelease(left.prerelease, right.prerelease);
    if (order !== 0) return order < 0 ? -1 : 1;
  }

  return 0;
}

/**
 * Whether `version` is new enough to satisfy `minimum`.
 *
 * Anything unreadable is not: a client that cannot say what it is has not
 * demonstrated that it is current, and the whole point of a floor is that
 * clearing it must be positive rather than assumed. That also covers the
 * clients this was written for -- versions old enough to predate the header
 * send nothing at all.
 */
export function meetsMinimum(version: string | null | undefined, minimum: string): boolean {
  if (!version) return false;
  const order = compareVersions(version, minimum);
  return order === null ? false : order >= 0;
}
