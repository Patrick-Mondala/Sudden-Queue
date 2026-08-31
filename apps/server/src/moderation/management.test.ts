import { isFail, isOk } from "@suddenqueue/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { playerRatings, users } from "../db/schema/index.js";
import { makeUser, setupTestDatabase, truncateAll } from "../test/helpers.js";
import { ManagementService } from "./management.js";
import { ModerationService } from "./service.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let management: ManagementService;
let moderation: ModerationService;

beforeAll(async () => {
  handle = await setupTestDatabase();
  management = new ManagementService(handle.db);
  moderation = new ModerationService(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

describe("lifting a cooldown", () => {
  it("clears the timer and the escalation behind it", async () => {
    const gm = await makeUser(handle);
    const player = await makeUser(handle, { gamesPlayed: 40 });

    await handle.db
      .update(playerRatings)
      .set({ queueCooldownUntil: new Date(Date.now() + 600_000), recentMissedAccepts: 3 })
      .where(eq(playerRatings.userId, player));

    expect(isOk(await management.clearCooldown(gm, player))).toBe(true);

    // Both, because the next cooldown's length comes from the counter rather
    // than the timestamp -- clearing one alone would let them queue now and
    // then jump them up the ladder on their next miss.
    const [after] = await handle.db
      .select({
        until: playerRatings.queueCooldownUntil,
        recent: playerRatings.recentMissedAccepts,
      })
      .from(playerRatings)
      .where(eq(playerRatings.userId, player));

    expect(after!.until).toBeNull();
    expect(after!.recent).toBe(0);
  });
});

describe("clearing an in-game name", () => {
  it("empties it rather than choosing a replacement", async () => {
    const gm = await makeUser(handle);
    const player = await makeUser(handle);
    await handle.db.update(users).set({ inGameName: "SOMETHING_VILE" }).where(eq(users.id, player));

    expect(isOk(await management.clearInGameName(gm, player))).toBe(true);

    const [after] = await handle.db
      .select({ inGameName: users.inGameName })
      .from(users)
      .where(eq(users.id, player));

    // A Game Master picking a name for somebody is a worse idea than the one
    // it replaced; empty puts them back in the prompt that asks for one.
    expect(after!.inGameName).toBeNull();
  });
});

describe("correcting rating by hand", () => {
  it("moves the number and leaves a row saying who and why", async () => {
    const gm = await makeUser(handle);
    const player = await makeUser(handle, { gamesPlayed: 40, rating: 1200 });

    const r = await management.adjustRating(gm, player, -50, "reversing a bug");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.rating).toBe(1150);

    const entries = await management.audit();
    expect(entries[0]!.eventType).toBe("rating.adjusted");
  });

  it("refuses an adjustment with no reason, and a silly one", async () => {
    const gm = await makeUser(handle);
    const player = await makeUser(handle, { gamesPlayed: 40 });

    expect(isFail(await management.adjustRating(gm, player, -50, "   "))).toBe(true);
    expect(isFail(await management.adjustRating(gm, player, 0, "nothing"))).toBe(true);
    expect(isFail(await management.adjustRating(gm, player, 99_999, "too much"))).toBe(true);
  });
});

describe("the audit log and the bans wall", () => {
  it("reads back what staff have done, newest first", async () => {
    const gm = await makeUser(handle);
    const player = await makeUser(handle, { gamesPlayed: 40 });

    await management.clearCooldown(gm, player);
    await management.clearInGameName(gm, player);

    const entries = await management.audit();
    expect(entries[0]!.eventType).toBe("ingamename.cleared");
    expect(entries[1]!.eventType).toBe("cooldown.cleared");
    expect(entries[0]!.actorId).toBe(gm);
  });

  it("lists bans as they were handed down, most recent first", async () => {
    const gm = await makeUser(handle);
    const first = await makeUser(handle);
    const second = await makeUser(handle);

    const actor = { userId: gm, role: "game_master" as const };
    expect(isOk(await moderation.suspend(actor, first, 24, "Griefing"))).toBe(true);
    expect(isOk(await moderation.suspend(actor, second, 48, "Abuse in chat"))).toBe(true);

    const bans = await moderation.banHistory();

    expect(bans).toHaveLength(2);
    expect(bans[0]!.userId).toBe(second);
    expect(bans[0]!.reason).toBe("Abuse in chat");
    expect(bans[0]!.hours).toBe(48);
    expect(bans[0]!.byName).toBeTruthy();
    expect(bans[0]!.active).toBe(true);
  });

  it("keeps a lifted ban on the wall, no longer active", async () => {
    const gm = await makeUser(handle);
    const player = await makeUser(handle);
    const actor = { userId: gm, role: "game_master" as const };

    await moderation.suspend(actor, player, 24, "Griefing");
    await moderation.lift(actor, player, "Apologised");

    // It is a record of what was done, not a list of who is currently out.
    const bans = await moderation.banHistory();
    expect(bans).toHaveLength(1);
    expect(bans[0]!.reason).toBe("Griefing");
  });
});
