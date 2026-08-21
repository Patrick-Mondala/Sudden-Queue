import { isOk } from "@suddenqueue/core";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import { users } from "../db/schema/index.js";
import { MatchLifecycle } from "../match/lifecycle.js";
import { makeParty, setupTestDatabase, truncateAll } from "../test/helpers.js";
import { QueueRepository } from "./repository.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let queue: QueueRepository;
let lifecycle: MatchLifecycle;

beforeAll(async () => {
  handle = await setupTestDatabase();
  queue = new QueueRepository(handle.db);
  lifecycle = new MatchLifecycle(handle.db);
}, 60_000);

afterAll(async () => { await handle?.close(); });
beforeEach(async () => { await truncateAll(handle); });

describe("population counts", () => {
  it("counts each queued player exactly once", async () => {
    // The lobby adds nothing of its own to these, so a player counted twice
    // here is a player shown twice.
    const solo = await makeParty(handle, 1);
    await queue.join({ partyId: solo.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });
    expect(await queue.countQueuedPlayers()).toBe(1);

    const duo = await makeParty(handle, 2);
    await queue.join({ partyId: duo.partyId, regions: ["na"], ratingSnapshot: 1200, size: 2 });
    expect(await queue.countQueuedPlayers()).toBe(3);
  });

  it("moves players out of the queue count and into the match count", async () => {
    const parties = [];
    for (let i = 0; i < 10; i += 1) {
      const p = await makeParty(handle, 1);
      await queue.join({ partyId: p.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });
      parties.push(p);
    }

    expect(await queue.countQueuedPlayers()).toBe(10);
    expect(await lifecycle.countPlayersInMatches()).toBe(0);

    const created = await lifecycle.createFromDecision(
      {
        anchorPartyId: parties[0]!.partyId,
        team1PartyIds: parties.slice(0, 5).map((p) => p.partyId),
        team2PartyIds: parties.slice(5).map((p) => p.partyId),
        team1Rating: 1200,
        team2Rating: 1200,
        gap: 0,
        allowedGap: 100,
        symmetryScore: 0,
      },
      "na",
    );
    expect(isOk(created)).toBe(true);

    // Nobody is in both places at once, and nobody vanishes in between.
    expect(await queue.countQueuedPlayers()).toBe(0);
    expect(await lifecycle.countPlayersInMatches()).toBe(10);
  });
});

describe("what a client is allowed to see", () => {
  it("never sends a rating number on a roster", async () => {
    const parties = [];
    for (let i = 0; i < 10; i += 1) {
      const p = await makeParty(handle, 1, { rating: 1500, gamesPlayed: 40 });
      await queue.join({ partyId: p.partyId, regions: ["na"], ratingSnapshot: 1500, size: 1 });
      parties.push(p);
    }

    const created = await lifecycle.createFromDecision(
      {
        anchorPartyId: parties[0]!.partyId,
        team1PartyIds: parties.slice(0, 5).map((p) => p.partyId),
        team2PartyIds: parties.slice(5).map((p) => p.partyId),
        team1Rating: 1500,
        team2Rating: 1500,
        gap: 0,
        allowedGap: 100,
        symmetryScore: 0,
      },
      "na",
    );
    if (!isOk(created)) throw new Error("staging failed");

    const view = await lifecycle.view(created.data.matchId);
    const wire = JSON.stringify(view);

    // Rank is what a player is shown. Shipping the number and hiding it in the
    // UI would leave the rule one devtools tab from being false.
    expect(wire).not.toMatch(/1500/);
    expect(view!.team1Tier).toBeTruthy();
    for (const p of [...view!.team1, ...view!.team2]) {
      expect(p).not.toHaveProperty("rating");
      expect(p.tier).toBe("G");
      expect(p.placementsRemaining).toBe(0);
    }
  });

  it("shows a placement player as unranked rather than as a number", async () => {
    const p = await makeParty(handle, 1, { rating: 1200, gamesPlayed: 2 });
    await queue.join({ partyId: p.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    const others = [];
    for (let i = 0; i < 9; i += 1) {
      const q = await makeParty(handle, 1, { rating: 1200, gamesPlayed: 40 });
      await queue.join({ partyId: q.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });
      others.push(q);
    }

    const created = await lifecycle.createFromDecision(
      {
        anchorPartyId: p.partyId,
        team1PartyIds: [p.partyId, ...others.slice(0, 4).map((x) => x.partyId)],
        team2PartyIds: others.slice(4).map((x) => x.partyId),
        team1Rating: 1200,
        team2Rating: 1200,
        gap: 0,
        allowedGap: 100,
        symmetryScore: 0,
      },
      "na",
    );
    if (!isOk(created)) throw new Error("staging failed");

    const view = await lifecycle.view(created.data.matchId);
    const unplaced = [...view!.team1, ...view!.team2].find((x) => x.id === p.userIds[0]);

    expect(unplaced!.tier).toBeNull();
    expect(unplaced!.placementsRemaining).toBe(3);
  });
});

describe("a match missing players", () => {
  it("is not offered as something the client can draw", async () => {
    // Deleting a user cascades their participant rows away. A match left with
    // half a roster used to sit in history as a row that could not be opened,
    // so the view has to be honest about what it can still produce.
    const parties = [];
    for (let i = 0; i < 10; i += 1) {
      const p = await makeParty(handle, 1, { gamesPlayed: 40 });
      await queue.join({ partyId: p.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });
      parties.push(p);
    }

    const created = await lifecycle.createFromDecision(
      {
        anchorPartyId: parties[0]!.partyId,
        team1PartyIds: parties.slice(0, 5).map((p) => p.partyId),
        team2PartyIds: parties.slice(5).map((p) => p.partyId),
        team1Rating: 1200,
        team2Rating: 1200,
        gap: 0,
        allowedGap: 100,
        symmetryScore: 0,
      },
      "na",
    );
    if (!isOk(created)) throw new Error("staging failed");

    const full = await lifecycle.view(created.data.matchId);
    expect(full!.team2).toHaveLength(5);

    // Remove one side the way deleting an account does.
    for (const p of parties.slice(5)) {
      await handle.db.delete(users).where(eq(users.id, p.userIds[0]!));
    }

    const gutted = await lifecycle.view(created.data.matchId);
    expect(gutted!.team1).toHaveLength(5);
    expect(gutted!.team2).toHaveLength(0);
  });
});
