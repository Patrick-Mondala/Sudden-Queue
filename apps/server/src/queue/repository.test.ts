import { QUEUE_STALE_AFTER_SECONDS } from "@suddenqueue/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { queueTickets, users } from "../db/schema/index.js";
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
    const { partyId, userIds } = await makeParty(handle, 1);
    await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    const before = (await repo.getByPartyId(partyId))!.heartbeatAt;
    await new Promise((r) => setTimeout(r, 25));
    expect(await repo.heartbeat(partyId, userIds[0]!)).toBe(true);

    const after = (await repo.getByPartyId(partyId))!.heartbeatAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("heartbeat on a missing ticket reports failure rather than creating one", async () => {
    const { partyId, userIds } = await makeParty(handle, 1);
    expect(await repo.heartbeat(partyId, userIds[0]!)).toBe(false);
  });

  it("prunes a party whose player has gone, and leaves a present one alone", async () => {
    const gone = await makeParty(handle, 1);
    const here = await makeParty(handle, 1);
    await repo.join({ partyId: gone.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });
    await repo.join({ partyId: here.partyId, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    // Both look equally quiet by the clock. The only difference is that the
    // server is still holding a socket for one of them, and that is now what
    // decides it.
    await handle.db
      .update(users)
      .set({ lastSeenAt: new Date(Date.now() - (QUEUE_STALE_AFTER_SECONDS + 10) * 1000) });

    const pruned = await repo.pruneStale([here.userIds[0]!]);

    expect(pruned).toEqual([gone.partyId]);
    expect(await repo.getByPartyId(here.partyId)).not.toBeNull();
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

describe("a party is only queueable while all of it is there", () => {
  /** Backdates a member's last-seen, the way closing the app does. */
  async function goQuiet(userId: string, secondsAgo: number) {
    await handle.db
      .update(users)
      .set({ lastSeenAt: new Date(Date.now() - secondsAgo * 1000) })
      .where(eq(users.id, userId));
  }

  it("drops a party whose ticket is fresh but whose members are not", async () => {
    const { partyId, userIds } = await makeParty(handle, 5);
    await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 5 });

    // One member keeps heartbeating; the other four close the app. The ticket
    // itself stays fresh, which is exactly how a stack of ghosts used to reach
    // a match and make ten people eat the cancellation.
    await repo.heartbeat(partyId, userIds[0]!);
    for (const id of userIds.slice(1)) await goQuiet(id, QUEUE_STALE_AFTER_SECONDS + 5);

    const pruned = await repo.pruneStale();
    expect(pruned).toContain(partyId);
    expect(await repo.countQueuedPlayers()).toBe(0);
  });

  it("leaves a party alone while every member is still checking in", async () => {
    const { partyId, userIds } = await makeParty(handle, 3);
    await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 3 });

    for (const id of userIds) await repo.heartbeat(partyId, id);

    expect(await repo.pruneStale()).not.toContain(partyId);
    expect(await repo.countQueuedPlayers()).toBe(3);
  });

  it("keeps a place for a tab the browser has throttled", async () => {
    // The bug this rule replaced. A hidden tab has its timers cut to about one
    // a minute after five minutes, so the heartbeat that used to prove liveness
    // stopped arriving inside a twenty second window -- and the player was
    // swept out of a queue they were still sat waiting in, having done nothing
    // but look at another tab, which is the entire point of queueing.
    //
    // Every timestamp here is well past the cutoff. The socket is still open,
    // and that is enough.
    const { partyId, userIds } = await makeParty(handle, 3);
    await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 3 });
    for (const id of userIds) await goQuiet(id, QUEUE_STALE_AFTER_SECONDS + 300);

    expect(await repo.pruneStale(userIds)).not.toContain(partyId);
    expect(await repo.countQueuedPlayers()).toBe(3);
  });

  it("drops them once the socket goes too, not merely the heartbeat", async () => {
    const { partyId, userIds } = await makeParty(handle, 3);
    await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 3 });
    for (const id of userIds) await goQuiet(id, QUEUE_STALE_AFTER_SECONDS + 300);

    // Two are still connected; the third closed the browser. A party is only
    // queueable while all of it is there.
    expect(await repo.pruneStale(userIds.slice(0, 2))).toContain(partyId);
  });

  it("treats joining as a sign of life, so a fresh ticket survives its first tick", async () => {
    // Nobody has heartbeated yet at this point; without the stamp on join the
    // whole party would read as absent and be pruned immediately.
    const { partyId } = await makeParty(handle, 4);
    await repo.join({ partyId, regions: ["na"], ratingSnapshot: 1200, size: 4 });

    expect(await repo.pruneStale()).not.toContain(partyId);
  });
});
