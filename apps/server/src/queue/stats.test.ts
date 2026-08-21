import { isOk } from "@suddenqueue/core";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

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
