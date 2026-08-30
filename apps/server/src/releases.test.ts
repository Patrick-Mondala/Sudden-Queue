import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReleaseFloor } from "./releases.js";

const dirs: string[] = [];

/** A releases directory of its own, removed when the test file is done. */
function releasesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sq-releases-"));
  dirs.push(dir);
  return dir;
}

function publish(dir: string, body: unknown, { at }: { at?: Date } = {}): void {
  const path = join(dir, "latest.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  // Written and rewritten inside the same millisecond otherwise, which on a
  // coarse filesystem clock is indistinguishable from not having changed.
  if (at) utimesSync(path, at, at);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the release floor", () => {
  it("is nothing at all without a directory", () => {
    expect(createReleaseFloor(null).current()).toBeNull();
    expect(createReleaseFloor(undefined).current()).toBeNull();
    expect(createReleaseFloor("").current()).toBeNull();
  });

  it("is the version latest.json names", () => {
    const dir = releasesDir();
    publish(dir, { version: "0.1.2", platforms: {} });

    expect(createReleaseFloor(dir).current()).toBe("0.1.2");
  });

  it("is nothing when the deployment has published nothing", () => {
    // A directory that exists and is empty is a deployment that has not
    // released yet. Refusing every client here would be far worse than
    // admitting an old one.
    expect(createReleaseFloor(releasesDir()).current()).toBeNull();
  });

  it("is nothing when the file is not readable as a release", () => {
    const dir = releasesDir();

    publish(dir, "{ half a file");
    expect(createReleaseFloor(dir).current()).toBeNull();

    // A copy in progress looks exactly like this, so it is worth nothing more
    // than waiting for the next check.
    publish(dir, { notes: "no version here" });
    expect(createReleaseFloor(dir, { recheckMs: 0 }).current()).toBeNull();

    publish(dir, { version: "not-a-version" });
    expect(createReleaseFloor(dir, { recheckMs: 0 }).current()).toBeNull();
  });

  it("follows the file when a new release is published", () => {
    const dir = releasesDir();
    publish(dir, { version: "0.1.2" }, { at: new Date(Date.now() - 60_000) });

    const floor = createReleaseFloor(dir, { recheckMs: 0 });
    expect(floor.current()).toBe("0.1.2");

    publish(dir, { version: "0.2.0" });
    expect(floor.current()).toBe("0.2.0");
  });

  it("forgets the floor when the manifest is taken away", () => {
    const dir = releasesDir();
    publish(dir, { version: "0.1.2" });

    const floor = createReleaseFloor(dir, { recheckMs: 0 });
    expect(floor.current()).toBe("0.1.2");

    rmSync(join(dir, "latest.json"));

    // A deployment that has removed its manifest is not still entitled to the
    // floor it used to name.
    expect(floor.current()).toBeNull();
  });

  it("does not read the file on every request", () => {
    const dir = releasesDir();
    publish(dir, { version: "0.1.2" }, { at: new Date(Date.now() - 60_000) });

    const floor = createReleaseFloor(dir, { recheckMs: 60_000 });
    expect(floor.current()).toBe("0.1.2");

    publish(dir, { version: "0.2.0" });

    // Still the cached answer: the point of the interval is that a stat does
    // not happen once per incoming request.
    expect(floor.current()).toBe("0.1.2");
  });
});
