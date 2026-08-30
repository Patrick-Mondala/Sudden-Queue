import { describe, expect, it } from "vitest";

import { compareVersions, meetsMinimum, parseVersion } from "./version.js";

describe("parseVersion", () => {
  it("reads the three numbers", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it("reads a prerelease as its identifiers", () => {
    expect(parseVersion("0.2.0-rc.1")?.prerelease).toEqual(["rc", "1"]);
  });

  it("accepts build metadata and drops it", () => {
    expect(parseVersion("1.2.3+20260830")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it("returns null for anything that is not a version", () => {
    for (const bad of ["", "1.2", "1.2.3.4", "v1.2.3", "latest", "1.2.x", "  "]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  it("compares numerically, not as text", () => {
    // The bug this exists to prevent: "10" sorts before "9" as a string.
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3+a", "1.2.3+b")).toBe(0);
  });

  it("sorts a prerelease below the release of the same numbers", () => {
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.0-rc.1")).toBe(1);
  });

  it("orders prereleases against each other", () => {
    expect(compareVersions("0.2.0-rc.1", "0.2.0-rc.2")).toBe(-1);
    expect(compareVersions("0.2.0-alpha", "0.2.0-beta")).toBe(-1);
    // A shorter run of otherwise equal identifiers comes first.
    expect(compareVersions("0.2.0-rc", "0.2.0-rc.1")).toBe(-1);
    // Numeric identifiers rank below alphanumeric ones.
    expect(compareVersions("0.2.0-1", "0.2.0-alpha")).toBe(-1);
  });

  it("says null rather than guessing at nonsense", () => {
    expect(compareVersions("1.2.3", "banana")).toBeNull();
    expect(compareVersions("", "1.2.3")).toBeNull();
  });
});

describe("meetsMinimum", () => {
  it("accepts the floor itself and anything above it", () => {
    expect(meetsMinimum("0.1.2", "0.1.2")).toBe(true);
    expect(meetsMinimum("0.2.0", "0.1.2")).toBe(true);
  });

  it("refuses anything below the floor", () => {
    expect(meetsMinimum("0.1.1", "0.1.2")).toBe(false);
  });

  it("refuses a release candidate for the floor it precedes", () => {
    expect(meetsMinimum("0.2.0-rc.1", "0.2.0")).toBe(false);
  });

  it("refuses a client that cannot say what it is", () => {
    // Versions old enough to predate the header send nothing at all, which is
    // exactly the case the floor exists to catch.
    expect(meetsMinimum(null, "0.1.2")).toBe(false);
    expect(meetsMinimum(undefined, "0.1.2")).toBe(false);
    expect(meetsMinimum("", "0.1.2")).toBe(false);
    expect(meetsMinimum("not-a-version", "0.1.2")).toBe(false);
  });
});
