import { PLACEMENT_GAMES, isOk } from "@suddenqueue/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TeamService } from "../team/service.js";
import { expectNoRatings, makeUser, setupTestDatabase, truncateAll } from "../test/helpers.js";
import { LadderService } from "./service.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let ladder: LadderService;
let team: TeamService;

beforeAll(async () => {
  handle = await setupTestDatabase();
  ladder = new LadderService(handle.db);
  team = new TeamService(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

const placed = (rating: number) => makeUser(handle, { rating, gamesPlayed: 40 });

describe("the ladder", () => {
  it("ranks placed players best first", async () => {
    await placed(1300);
    const best = await placed(1700);
    await placed(1100);

    const rows = await ladder.top(10, 0);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.userId).toBe(best);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3]);
  });

  it("leaves out anyone still in placements", async () => {
    await placed(1500);
    const rookie = await makeUser(handle, { rating: 1900, gamesPlayed: PLACEMENT_GAMES - 1 });

    // A placement rating is a guess, and a ladder is a claim about who is
    // better -- so a rookie does not top it on four lucky games.
    const rows = await ladder.top(10, 0);
    expect(rows.map((r) => r.userId)).not.toContain(rookie);
    expect(await ladder.count()).toBe(1);
  });

  it("publishes rank and record, never a rating", async () => {
    await placed(1500);
    const [row] = await ladder.top(10, 0);

    expect(row!.tier).toBeTruthy();
    expect(row).not.toHaveProperty("rating");
    expectNoRatings(row);
  });

  it("keeps positions continuous across pages", async () => {
    for (let i = 0; i < 7; i += 1) await placed(1000 + i * 50);

    const first = await ladder.top(3, 0);
    const second = await ladder.top(3, 3);

    expect(first.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(second.map((r) => r.position)).toEqual([4, 5, 6]);
    // No overlap between pages, which a tie-less ORDER BY would not guarantee.
    expect(second.map((r) => r.userId)).not.toContain(first[0]!.userId);
  });

  it("orders ties the same way everywhere it is asked", async () => {
    const a = await placed(1400);
    const b = await placed(1400);

    const rows = await ladder.top(10, 0);
    const fromList = new Map(rows.map((r) => [r.userId, r.position]));

    // A position must not depend on which query produced it.
    expect(await ladder.positionFor(a)).toBe(fromList.get(a));
    expect(await ladder.positionFor(b)).toBe(fromList.get(b));
  });

  it("shows the team someone plays for", async () => {
    const captain = await placed(1500);
    const created = await team.create(captain, { tag: "ACE", name: "Aces", region: "na" });
    expect(isOk(created)).toBe(true);

    const [row] = await ladder.top(10, 0);
    expect(row!.teamTag).toBe("ACE");
  });
});

describe("your own standing", () => {
  it("is reported even when it falls outside the page being read", async () => {
    for (let i = 0; i < 5; i += 1) await placed(1600 + i * 10);
    const last = await placed(900);

    const rows = await ladder.top(3, 0);
    expect(rows.map((r) => r.userId)).not.toContain(last);

    // Otherwise someone at 300th has to page down to find themselves.
    expect(await ladder.positionFor(last)).toBe(6);
  });

  it("is null while you are still in placements", async () => {
    const rookie = await makeUser(handle, { gamesPlayed: 2 });
    expect(await ladder.positionFor(rookie)).toBeNull();
  });
});

describe("a public profile", () => {
  it("publishes rank, peak and record without the numbers behind them", async () => {
    const user = await placed(1500);
    const profile = await ladder.profile(user);

    expect(profile!.tier).toBeTruthy();
    expect(profile!.peakTier).toBeTruthy();
    expect(profile!.position).toBe(1);
    expectNoRatings(profile);
  });

  it("shows an unplaced player as unranked, with the count remaining", async () => {
    const rookie = await makeUser(handle, { gamesPlayed: 2 });
    const profile = await ladder.profile(rookie);

    expect(profile!.tier).toBeNull();
    expect(profile!.peakTier).toBeNull();
    expect(profile!.position).toBeNull();
    expect(profile!.placementsRemaining).toBe(PLACEMENT_GAMES - 2);
  });

  it("names their team when they have one", async () => {
    const captain = await placed(1500);
    await team.create(captain, { tag: "ACE", name: "Aces", region: "na" });

    const profile = await ladder.profile(captain);
    expect(profile!.team).toEqual(
      expect.objectContaining({ tag: "ACE", name: "Aces", role: "captain" }),
    );
  });

  it("is null for a stranger", async () => {
    expect(await ladder.profile("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
