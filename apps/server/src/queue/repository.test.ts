import { QUEUE_STALE_AFTER_SECONDS } from "@suddenqueue/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { queueTickets } from "../db/schema/index.js";
import { makeParty, setupTestDatabase, truncateAll } from "../test/helpers.js";
import { QueueRepository } from "./repository.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let repo: QueueRepository;

beforeAll(async () => {
  handle = await setupTestDatabase();
  repo = new QueueRepository(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

describe("joining and leaving", () => {
  it("creates a ticket", async () => {
    const { partyId } = await makeParty(handle, 2);
    const ticket = await repo.join({
      partyId,
      regions: ["na"],
      ratingSnapshot: 1200,
      size: 2,
    });

    expect(ticket).not.toBeNull();
    expect(await repo.getByPartyId(partyId)).not.toBeNull();
  });

  it("refuses a second ticket for the same party", async () => {
    const { partyId } = await makeParty(handle, 1);
    const first = await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });
    const second = await repo.join({ partyId, regions: ["eu"], ratingSnapshot: 1200, size: 1 });

    // Enforced by the unique index, so it cannot race.
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("leaving removes the ticket and is idempotent", async () => {
    const { partyId } = await makeParty(handle, 1);
    await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    expect(await repo.leave(partyId)).toBe(true);
    expect(await repo.leave(partyId)).toBe(false);
    expect(await repo.getByPartyId(partyId)).toBeNull();
  });

  it("drops the ticket when its party is deleted", async () => {
    const { partyId } = await makeParty(handle, 1);
    await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    await handle.db.execute(sql`DELETE FROM parties WHERE id = ${partyId}`);
    expect(await repo.getByPartyId(partyId)).toBeNull();
  });
});

describe("region pools", () => {
  it("includes a party in every region it queued for", async () => {
    const { partyId } = await makeParty(handle, 1);
    await repo.join({ partyId, regions: ["na", "eu"], ratingSnapshot: 1200, size: 1 });

    expect((await repo.poolForRegion("na")).map((t) => t.partyId)).toContain(partyId);
    expect((await repo.poolForRegion("eu")).map((t) => t.partyId)).toContain(partyId);
    expect(await repo.poolForRegion("asia")).toHaveLength(0);
  });

  it("returns the pool oldest first, so the matchmaker anchors correctly", async () => {
    const a = await makeParty(handle, 1);
    await repo.join({ partyId: a.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    // Age the first ticket so ordering is unambiguous.
    await handle.db.execute(
      sql`UPDATE queue_tickets SET joined_at = now() - interval '5 minutes' WHERE party_id = ${a.partyId}`,
    );

    const b = await makeParty(handle, 1);
    await repo.join({ partyId: b.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    const pool = await repo.poolForRegion("na");
    expect(pool[0]!.partyId).toBe(a.partyId);
  });

  it("reports active regions and queued player count", async () => {
    const a = await makeParty(handle, 3);
    const b = await makeParty(handle, 2);
    await repo.join({ partyId: a.partyId, regions: ["na"], ratingSnapshot: 1200, size: 3 });
    await repo.join({ partyId: b.partyId, regions: ["eu"], ratingSnapshot: 1200, size: 2 });

    expect((await repo.activeRegions()).sort()).toEqual(["eu", "na"]);
    // Counts players, not tickets.
    expect(await repo.countQueuedPlayers()).toBe(5);
  });

  it("converts timestamps to epoch seconds for the scorer", async () => {
    const { partyId } = await makeParty(handle, 1);
    await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    const [ticket] = await repo.poolForRegion("na");
    expect(Number.isInteger(ticket!.joinedAt)).toBe(true);
    expect(Math.abs(ticket!.joinedAt - Math.floor(Date.now() / 1000))).toBeLessThan(30);
  });
});

describe("heartbeat and staleness", () => {
  it("heartbeat extends a live ticket", async () => {
    const { partyId } = await makeParty(handle, 1);
    await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    const before = (await repo.getByPartyId(partyId))!.heartbeatAt;
    await new Promise((r) => setTimeout(r, 25));
    expect(await repo.heartbeat(partyId)).toBe(true);

    const after = (await repo.getByPartyId(partyId))!.heartbeatAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("heartbeat on a missing ticket reports failure rather than creating one", async () => {
    const { partyId } = await makeParty(handle, 1);
    expect(await repo.heartbeat(partyId)).toBe(false);
  });

  it("prunes tickets whose client went quiet, and leaves fresh ones alone", async () => {
    const stale = await makeParty(handle, 1);
    const fresh = await makeParty(handle, 1);
    await repo.join({ partyId: stale.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });
    await repo.join({ partyId: fresh.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    await handle.db.execute(
      sql`UPDATE queue_tickets
          SET heartbeat_at = now() - interval '${sql.raw(String(QUEUE_STALE_AFTER_SECONDS + 10))} seconds'
          WHERE party_id = ${stale.partyId}`,
    );

    const pruned = await repo.pruneStale();
    expect(pruned).toEqual([stale.partyId]);
    expect(await repo.getByPartyId(fresh.partyId)).not.toBeNull();
  });
});

describe("party membership lookup", () => {
  it("groups members by party", async () => {
    const a = await makeParty(handle, 3);
    const b = await makeParty(handle, 2);

    const members = await repo.membersOf([a.partyId, b.partyId]);
    expect(members.get(a.partyId)).toHaveLength(3);
    expect(members.get(b.partyId)).toHaveLength(2);
  });

  it("handles an empty request", async () => {
    expect((await repo.membersOf([])).size).toBe(0);
  });
});

describe("locking", () => {
  it("returns only tickets that still exist", async () => {
    const a = await makeParty(handle, 1);
    const b = await makeParty(handle, 1);
    await repo.join({ partyId: a.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    await handle.db.transaction(async (tx) => {
      const locked = await repo.lockTickets(tx, [a.partyId, b.partyId]);
      expect(locked).toHaveLength(1);
      expect(locked[0]!.partyId).toBe(a.partyId);
    });
  });
});
