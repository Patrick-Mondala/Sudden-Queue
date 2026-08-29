import { isFail, isOk } from "@suddenqueue/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { users } from "../db/schema/index.js";
import { expectNoRatings, makeUser, setupTestDatabase, truncateAll } from "../test/helpers.js";
import {
  MAX_SUSPENSION_HOURS,
  MIN_SUSPENSION_HOURS,
  ModerationService,
  type Actor,
} from "./service.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let mod: ModerationService;

beforeAll(async () => {
  handle = await setupTestDatabase();
  mod = new ModerationService(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

const gm = async (): Promise<Actor> => {
  const id = await makeUser(handle);
  await handle.db.update(users).set({ role: "game_master" }).where(eq(users.id, id));
  return { userId: id, role: "game_master" };
};

const bannedUntilFor = async (userId: string) => {
  const [row] = await handle.db
    .select({ until: users.bannedUntil, reason: users.banReason })
    .from(users)
    .where(eq(users.id, userId));
  return row!;
};

describe("suspending an account", () => {
  it("records the end and the reason where login and the queue already look", async () => {
    const actor = await gm();
    const target = await makeUser(handle);

    const res = await mod.suspend(actor, target, 24, "Throwing matches");
    expect(isOk(res)).toBe(true);

    // These two columns were being read in two places and written in none.
    const row = await bannedUntilFor(target);
    expect(row.reason).toBe("Throwing matches");
    expect(row.until!.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a Game Master their own account", async () => {
    const actor = await gm();
    const res = await mod.suspend(actor, actor.userId, 24, "oops");

    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("CANNOT_SUSPEND_SELF");
  });

  it("will not let one Game Master suspend another", async () => {
    const actor = await gm();
    const other = await gm();

    // Not a dispute this should be able to have.
    const res = await mod.suspend(actor, other.userId, 24, "disagreement");
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("CANNOT_SUSPEND_STAFF");
  });

  it("lets an admin act on a Game Master", async () => {
    const other = await gm();
    const adminId = await makeUser(handle);
    await handle.db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));

    const res = await mod.suspend({ userId: adminId, role: "admin" }, other.userId, 24, "abuse");
    expect(isOk(res)).toBe(true);
  });

  it("never suspends an admin from here, even by another admin", async () => {
    const a = await makeUser(handle);
    const b = await makeUser(handle);
    await handle.db.update(users).set({ role: "admin" }).where(eq(users.id, a));
    await handle.db.update(users).set({ role: "admin" }).where(eq(users.id, b));

    const res = await mod.suspend({ userId: a, role: "admin" }, b, 24, "no");
    expect(isFail(res)).toBe(true);
  });

  it("insists on a reason", async () => {
    const actor = await gm();
    const target = await makeUser(handle);

    // The player is shown this when turned away, and a later Game Master reads
    // it to judge whether the call was fair.
    const res = await mod.suspend(actor, target, 24, "   ");
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("INVALID_REASON");
  });

  it("holds the duration inside its bounds", async () => {
    const actor = await gm();
    const target = await makeUser(handle);

    for (const hours of [0, MIN_SUSPENSION_HOURS - 1, MAX_SUSPENSION_HOURS + 1, Number.NaN]) {
      const res = await mod.suspend(actor, target, hours, "reason");
      expect(isFail(res)).toBe(true);
      if (isFail(res)) expect(res.code).toBe("INVALID_DURATION");
    }
  });

  it("says so when there is no such account", async () => {
    const actor = await gm();
    const res = await mod.suspend(actor, "00000000-0000-0000-0000-000000000000", 24, "reason");

    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("USER_NOT_FOUND");
  });
});

describe("lifting a suspension", () => {
  it("clears both the date and the reason", async () => {
    const actor = await gm();
    const target = await makeUser(handle);
    await mod.suspend(actor, target, 24, "Throwing matches");

    const res = await mod.lift(actor, target, "Appealed, footage cleared them");
    expect(isOk(res)).toBe(true);

    const row = await bannedUntilFor(target);
    expect(row.until).toBeNull();
    // A stale reason on an unsuspended account reads as a mark against them.
    expect(row.reason).toBeNull();
  });

  it("refuses when they are not serving one", async () => {
    const actor = await gm();
    const target = await makeUser(handle);

    const res = await mod.lift(actor, target, "");
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("NOT_SUSPENDED");
  });

  it("treats an expired suspension as already served", async () => {
    const actor = await gm();
    const target = await makeUser(handle);
    await handle.db
      .update(users)
      .set({ bannedUntil: new Date(Date.now() - 1000), banReason: "old" })
      .where(eq(users.id, target));

    const res = await mod.lift(actor, target, "");
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("NOT_SUSPENDED");
  });
});

describe("the record", () => {
  it("keeps who did it, to whom, and why", async () => {
    const actor = await gm();
    const target = await makeUser(handle);
    await mod.suspend(actor, target, 48, "Throwing matches");

    const [entry] = await mod.historyFor(target);
    expect(entry).toMatchObject({ eventType: "user.suspended", actorId: actor.userId });
    expect(entry!.payload).toMatchObject({ hours: 48, reason: "Throwing matches" });
  });

  it("keeps the lift as well as the suspension", async () => {
    const actor = await gm();
    const target = await makeUser(handle);
    await mod.suspend(actor, target, 48, "Throwing matches");
    await mod.lift(actor, target, "Appealed");

    const entries = await mod.historyFor(target);
    // Most recent first, and the original reason survives on the lift so the
    // pair reads as one story.
    expect(entries.map((e) => e.eventType)).toEqual(["user.reinstated", "user.suspended"]);
    expect(entries[0]!.payload).toMatchObject({ originalReason: "Throwing matches" });
  });

  it("names the Game Master who acted", async () => {
    const actor = await gm();
    const target = await makeUser(handle);
    await mod.suspend(actor, target, 1, "reason");

    const [entry] = await mod.historyFor(target);
    expect(entry!.actorName).toBeTruthy();
  });
});

describe("finding an account", () => {
  it("matches on part of a Discord name", async () => {
    const target = await makeUser(handle);
    await handle.db.update(users).set({ discordName: "Griefer99" }).where(eq(users.id, target));

    const found = await mod.search("grief");
    expect(found.map((u) => u.userId)).toContain(target);
  });

  it("matches on the in-game name", async () => {
    const target = await makeUser(handle);
    await handle.db.update(users).set({ inGameName: "SNIPER_X" }).where(eq(users.id, target));

    expect((await mod.search("sniper_x")).map((u) => u.userId)).toContain(target);
  });

  it("matches a Discord id pasted whole", async () => {
    const target = await makeUser(handle);
    await handle.db
      .update(users)
      .set({ discordId: "130891065069666304" })
      .where(eq(users.id, target));

    // What a Game Master actually has to hand from a report.
    expect((await mod.search("130891065069666304")).map((u) => u.userId)).toContain(target);
  });

  it("returns nothing for an empty search rather than everyone", async () => {
    await makeUser(handle);
    expect(await mod.search("   ")).toEqual([]);
  });

  it("publishes identity without a rating", async () => {
    const target = await makeUser(handle, { rating: 1500 });
    await handle.db.update(users).set({ discordName: "Findme" }).where(eq(users.id, target));

    const found = await mod.search("findme");
    expect(found[0]).not.toHaveProperty("rating");
    expectNoRatings(found);
  });
});

describe("the suspended list", () => {
  it("holds only those still serving, soonest to end first", async () => {
    const actor = await gm();
    const long = await makeUser(handle);
    const short = await makeUser(handle);
    const served = await makeUser(handle);

    await mod.suspend(actor, long, 48, "reason");
    await mod.suspend(actor, short, 2, "reason");
    await handle.db
      .update(users)
      .set({ bannedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, served));

    const list = await mod.suspended();
    expect(list.map((u) => u.userId)).toEqual([short, long]);
  });
});
