import { createHash } from "node:crypto";
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

const INSTALLER = "Sudden.Queue_0.1.2_x64-setup.exe";

/** Writes an installer and the SHA256SUMS line that vouches for it. */
function publishInstaller(dir: string, contents = "pretend this is an exe", name = INSTALLER): void {
  writeFileSync(join(dir, name), contents);
  const hash = createHash("sha256").update(contents).digest("hex");
  writeFileSync(join(dir, "SHA256SUMS"), `${hash}  ${name}\n`);
}

/** A manifest of the shape release-manifest.mjs writes. */
function manifest(version: string, installer = INSTALLER): unknown {
  return {
    version,
    platforms: {
      "windows-x86_64": {
        signature: "untrusted comment: …",
        url: `https://suddenqueue.com/download/${installer}`,
      },
    },
  };
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

  it("is the version latest.json names, once its installer checks out", () => {
    const dir = releasesDir();
    publishInstaller(dir);
    publish(dir, manifest("0.1.2"));

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
    publishInstaller(dir);

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
    publishInstaller(dir);
    publish(dir, manifest("0.1.2"), { at: new Date(Date.now() - 60_000) });

    const floor = createReleaseFloor(dir, { recheckMs: 0 });
    expect(floor.current()).toBe("0.1.2");

    publishInstaller(dir, "a newer exe", "Sudden.Queue_0.2.0_x64-setup.exe");
    publish(dir, manifest("0.2.0", "Sudden.Queue_0.2.0_x64-setup.exe"));
    expect(floor.current()).toBe("0.2.0");
  });

  it("forgets the floor when the manifest is taken away", () => {
    const dir = releasesDir();
    publishInstaller(dir);
    publish(dir, manifest("0.1.2"));

    const floor = createReleaseFloor(dir, { recheckMs: 0 });
    expect(floor.current()).toBe("0.1.2");

    rmSync(join(dir, "latest.json"));

    // A deployment that has removed its manifest is not still entitled to the
    // floor it used to name.
    expect(floor.current()).toBeNull();
  });

  it("does not read the file on every request", () => {
    const dir = releasesDir();
    publishInstaller(dir);
    publish(dir, manifest("0.1.2"), { at: new Date(Date.now() - 60_000) });

    const floor = createReleaseFloor(dir, { recheckMs: 60_000 });
    expect(floor.current()).toBe("0.1.2");

    publishInstaller(dir, "a newer exe", "Sudden.Queue_0.2.0_x64-setup.exe");
    publish(dir, manifest("0.2.0", "Sudden.Queue_0.2.0_x64-setup.exe"));

    // Still the cached answer: the point of the interval is that a stat does
    // not happen once per incoming request.
    expect(floor.current()).toBe("0.1.2");
  });
});

describe("checking the release before believing it", () => {
  it("does not rise while the installer is still being copied", () => {
    const dir = releasesDir();
    // The manifest arrived first -- the mistake the check exists for. Raising
    // the floor here locks everyone out of an app that cannot download the
    // version it is being told to install.
    publish(dir, manifest("0.2.0"));

    const problems: string[] = [];
    const floor = createReleaseFloor(dir, { recheckMs: 0, onProblem: (p) => problems.push(p) });

    expect(floor.current()).toBeNull();
    expect(problems.join(" ")).toMatch(/SHA256SUMS is missing/);
  });

  it("rises by itself once the installer lands", () => {
    const dir = releasesDir();
    publish(dir, manifest("0.2.0"));

    const floor = createReleaseFloor(dir, { recheckMs: 0 });
    expect(floor.current()).toBeNull();

    // The installer arriving does not touch latest.json, so a floor cached
    // against the manifest's mtime would stay off until the next publish --
    // a required update quietly made optional.
    publishInstaller(dir);
    expect(floor.current()).toBe("0.2.0");
  });

  it("refuses an installer that does not match its checksum", () => {
    const dir = releasesDir();
    publishInstaller(dir);
    publish(dir, manifest("0.2.0"));

    // Truncated in transit: the size is wrong and so is the hash.
    writeFileSync(join(dir, INSTALLER), "pretend this is a HALF");

    const problems: string[] = [];
    const floor = createReleaseFloor(dir, { recheckMs: 0, onProblem: (p) => problems.push(p) });

    expect(floor.current()).toBeNull();
    expect(problems.join(" ")).toMatch(/does not match SHA256SUMS/);
  });

  it("refuses an installer nothing vouches for", () => {
    const dir = releasesDir();
    publishInstaller(dir);
    publish(dir, manifest("0.2.0", "Sudden.Queue_0.9.9_x64-setup.exe"));

    const problems: string[] = [];
    const floor = createReleaseFloor(dir, { recheckMs: 0, onProblem: (p) => problems.push(p) });

    expect(floor.current()).toBeNull();
    expect(problems.join(" ")).toMatch(/does not list/);
  });

  it("says why once, not once per check", () => {
    const dir = releasesDir();
    publish(dir, manifest("0.2.0"));

    const problems: string[] = [];
    const floor = createReleaseFloor(dir, { recheckMs: 0, onProblem: (p) => problems.push(p) });

    floor.current();
    floor.current();
    floor.current();

    // The symptom of a bad publish is that nothing happens, so it has to be
    // diagnosable -- without filling the log every five seconds until someone
    // notices.
    expect(problems).toHaveLength(1);
  });
});
