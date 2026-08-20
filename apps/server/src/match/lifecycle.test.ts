import { isFail, isOk } from "@suddenqueue/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { matchParticipants, matches, parties } from "../db/schema/index.js";
import { QueueRepository } from "../queue/repository.js";
import { makeParty, setupTestDatabase, truncateAll } from "../test/helpers.js";
import { MatchLifecycle } from "./lifecycle.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let lifecycle: MatchLifecycle;
let queue: QueueRepository;

beforeAll(async () => {
  handle = await setupTestDatabase();
  lifecycle = new MatchLifecycle(handle.db);
  queue = new QueueRepository(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

/** Ten players across two teams, all queued, with a decision ready to commit. */
async function stageMatch(opts: { sizes1?: number[]; sizes2?: number[] } = {}) {
  const sizes1 = opts.sizes1 ?? [1, 1, 1, 1, 1];
  const sizes2 = opts.sizes2 ?? [1, 1, 1, 1, 1];

  const team1 = [];
  for (const s of sizes1) team1.push(await makeParty(handle, s));
  const team2 = [];
  for (const s of sizes2) team2.push(await makeParty(handle, s));

  for (const p of [...team1, ...team2]) {
    const size = [...team1, ...team2].find((x) => x.partyId === p.partyId)!.userIds.length;
    await queue.join({ partyId: p.partyId, regions: ["na"], ratingSnapshot: 1200, size });
  }

  return {
    team1,
    team2,
    decision: {
      anchorPartyId: team1[0]!.partyId,
      team1PartyIds: team1.map((p) => p.partyId),
      team2PartyIds: team2.map((p) => p.partyId),
      team1Rating: 1200,
      team2Rating: 1200,
      gap: 0,
      allowedGap: 100,
      symmetryScore: 0,
    },
  };
}

describe("committing a decision", () => {
  it("creates the match, its ten participants, and clears the queue", async () => {
    const { decision } = await stageMatch();
    const result = await lifecycle.createFromDecision(decision, "na");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.data.userIds).toHaveLength(10);

    const parts = await lifecycle.participants(result.data.matchId);
    expect(parts).toHaveLength(10);
    expect(parts.filter((p) => p.team === 1)).toHaveLength(5);
    expect(parts.filter((p) => p.team === 2)).toHaveLength(5);

    // Committed parties are no longer queueable.
    expect(await queue.countQueuedPlayers()).toBe(0);
  });

  it("opens in PENDING_ACCEPT with an accept deadline in the future", async () => {
    const { decision } = await stageMatch();
    const result = await lifecycle.createFromDecision(decision, "na");
    if (!isOk(result)) throw new Error("expected ok");

    const match = await lifecycle.getMatch(result.data.matchId);
    expect(match!.state).toBe("PENDING_ACCEPT");
    expect(match!.acceptDeadline!.getTime()).toBeGreaterThan(Date.now());
    expect(match!.partyUpDeadline).toBeNull();
  });

  it("names exactly one captain per side", async () => {
    const { decision } = await stageMatch();
    const result = await lifecycle.createFromDecision(decision, "na");
    if (!isOk(result)) throw new Error("expected ok");

    const parts = await lifecycle.participants(result.data.matchId);
    expect(parts.filter((p) => p.team === 1 && p.isCaptain)).toHaveLength(1);
    expect(parts.filter((p) => p.team === 2 && p.isCaptain)).toHaveLength(1);
  });

  it("gives the captaincy to the largest party's registered leader", async () => {
    const { team1, decision } = await stageMatch({ sizes1: [3, 1, 1], sizes2: [1, 1, 1, 1, 1] });
    const result = await lifecycle.createFromDecision(decision, "na");
    if (!isOk(result)) throw new Error("expected ok");

    const parts = await lifecycle.participants(result.data.matchId);
    const captain = parts.find((p) => p.team === 1 && p.isCaptain);
    // team1[0] is the 3-stack, and makeParty makes its first user the leader.
    expect(captain!.userId).toBe(team1[0]!.userIds[0]);
  });

  /**
   * Members created in one insert share a joined_at, because Postgres now() is
   * transaction scoped. Picking the captain by member order was therefore
   * unstable between runs; it now comes from parties.leaderId.
   */
  it("picks the same captain every time for identical input", async () => {
    const seen = new Set<string>();

    for (let run = 0; run < 5; run += 1) {
      await truncateAll(handle);
      const { decision } = await stageMatch({ sizes1: [3, 1, 1], sizes2: [1, 1, 1, 1, 1] });
      const result = await lifecycle.createFromDecision(decision, "na");
      if (!isOk(result)) throw new Error("expected ok");

      const parts = await lifecycle.participants(result.data.matchId);
      const captain = parts.find((p) => p.team === 1 && p.isCaptain)!;
      const largestParty = decision.team1PartyIds[0]!;

      // Captain must be the leader of the 3-stack, not an arbitrary member.
      const [leader] = await handle.db
        .select({ leaderId: parties.leaderId })
        .from(parties)
        .where(eq(parties.id, largestParty));

      expect(captain.userId).toBe(leader!.leaderId);
      seen.add(captain.userId === leader!.leaderId ? "leader" : "other");
    }

    expect([...seen]).toEqual(["leader"]);
  });

  it("refuses when a party left the queue after being scored", async () => {
    const { team1, decision } = await stageMatch();

    // Simulate the race: the party leaves between scoring and commit.
    await queue.leave(team1[0]!.partyId);

    const result = await lifecycle.createFromDecision(decision, "na");
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.code).toBe("TICKET_DISAPPEARED");
  });

  it("leaves the other parties queued when a commit fails", async () => {
    const { team1, decision } = await stageMatch();
    await queue.leave(team1[0]!.partyId);

    await lifecycle.createFromDecision(decision, "na");

    // Nine players remain available rather than being stranded.
    expect(await queue.countQueuedPlayers()).toBe(9);
  });

  it("refuses to pull a party into a second concurrent match", async () => {
    const { decision } = await stageMatch();
    const first = await lifecycle.createFromDecision(decision, "na");
    expect(isOk(first)).toBe(true);

    // Re-queue the same parties and try to commit them again.
    for (const id of [...decision.team1PartyIds, ...decision.team2PartyIds]) {
      await queue.join({ partyId: id, regions: ["na"], ratingSnapshot: 1200, size: 1 });
    }

    const second = await lifecycle.createFromDecision(decision, "na");
    expect(isFail(second)).toBe(true);
    if (isFail(second)) expect(second.code).toBe("PARTY_ALREADY_MATCHED");
  });
});

describe("accepting", () => {
  async function created() {
    const staged = await stageMatch();
    const result = await lifecycle.createFromDecision(staged.decision, "na");
    if (!isOk(result)) throw new Error("expected ok");
    return result.data;
  }

  it("counts accepts and only advances once all ten are in", async () => {
    const match = await created();

    for (let i = 0; i < 9; i += 1) {
      const r = await lifecycle.accept(match.matchId, match.userIds[i]!);
      expect(isOk(r) && r.data.allAccepted).toBe(false);
    }

    const last = await lifecycle.accept(match.matchId, match.userIds[9]!);
    expect(isOk(last) && last.data.allAccepted).toBe(true);

    const after = await lifecycle.getMatch(match.matchId);
    expect(after!.state).toBe("PARTY_UP");
    expect(after!.partyUpDeadline).not.toBeNull();
    expect(after!.acceptDeadline).toBeNull();
  });

  it("is idempotent for a player who accepts twice", async () => {
    const match = await created();
    await lifecycle.accept(match.matchId, match.userIds[0]!);
    const again = await lifecycle.accept(match.matchId, match.userIds[0]!);

    expect(isOk(again)).toBe(true);
    if (isOk(again)) expect(again.data.accepted).toBe(1);
  });

  it("rejects someone who is not in the match", async () => {
    const match = await created();
    const outsider = await makeParty(handle, 1);

    const r = await lifecycle.accept(match.matchId, outsider.userIds[0]!);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("NOT_A_PARTICIPANT");
  });

  it("rejects accepts once the match has moved on", async () => {
    const match = await created();
    for (const u of match.userIds) await lifecycle.accept(match.matchId, u);

    const late = await lifecycle.accept(match.matchId, match.userIds[0]!);
    expect(isFail(late)).toBe(true);
    if (isFail(late)) expect(late.code).toBe("NOT_PENDING");
  });

  it("a decline cancels immediately rather than waiting out the timer", async () => {
    const match = await created();
    await lifecycle.accept(match.matchId, match.userIds[0]!);

    const r = await lifecycle.decline(match.matchId, match.userIds[1]!);
    expect(isOk(r)).toBe(true);

    const after = await lifecycle.getMatch(match.matchId);
    expect(after!.state).toBe("CANCELLED");
    expect(after!.cancelReason).toBe("DECLINED");
    expect(after!.resolvedAt).not.toBeNull();
  });
});

describe("expiry sweeper", () => {
  async function created() {
    const staged = await stageMatch();
    const result = await lifecycle.createFromDecision(staged.decision, "na");
    if (!isOk(result)) throw new Error("expected ok");
    return result.data;
  }

  async function expire(matchId: string, column: string) {
    await handle.db.execute(
      sql`UPDATE matches SET ${sql.raw(column)} = now() - interval '1 second' WHERE id = ${matchId}`,
    );
  }

  it("cancels a blown accept window and separates who missed it", async () => {
    const match = await created();
    // Two players accept; the rest do not.
    await lifecycle.accept(match.matchId, match.userIds[0]!);
    await lifecycle.accept(match.matchId, match.userIds[1]!);
    await expire(match.matchId, "accept_deadline");

    const result = await lifecycle.sweepExpired();

    expect(result.cancelled).toHaveLength(1);
    const c = result.cancelled[0]!;
    expect(c.matchId).toBe(match.matchId);
    expect(c.keptUserIds).toHaveLength(2);
    expect(c.missedUserIds).toHaveLength(8);

    const after = await lifecycle.getMatch(match.matchId);
    expect(after!.state).toBe("CANCELLED");
    expect(after!.cancelReason).toBe("ACCEPT_TIMEOUT");
  });

  it("moves party-up to LIVE and starts the report window", async () => {
    const match = await created();
    for (const u of match.userIds) await lifecycle.accept(match.matchId, u);
    await expire(match.matchId, "party_up_deadline");

    const result = await lifecycle.sweepExpired();
    expect(result.startedLive).toContain(match.matchId);

    const after = await lifecycle.getMatch(match.matchId);
    expect(after!.state).toBe("LIVE");
    expect(after!.reportDeadline!.getTime()).toBeGreaterThan(Date.now());
  });

  it("sends a one-sided report to dispute once its window closes", async () => {
    const match = await created();
    await handle.db
      .update(matches)
      .set({
        state: "REPORTED",
        reportDeadline: new Date(Date.now() - 1000),
      })
      .where(eq(matches.id, match.matchId));

    const result = await lifecycle.sweepExpired();
    expect(result.disputed).toContain(match.matchId);
    expect((await lifecycle.getMatch(match.matchId))!.state).toBe("DISPUTED");
  });

  it("leaves matches that are still inside their deadline alone", async () => {
    const match = await created();
    const result = await lifecycle.sweepExpired();

    expect(result.cancelled).toHaveLength(0);
    expect((await lifecycle.getMatch(match.matchId))!.state).toBe("PENDING_ACCEPT");
  });

  it("is safe to run repeatedly", async () => {
    const match = await created();
    await expire(match.matchId, "accept_deadline");

    const first = await lifecycle.sweepExpired();
    const second = await lifecycle.sweepExpired();

    expect(first.cancelled).toHaveLength(1);
    // Already cancelled, so nothing left to do.
    expect(second.cancelled).toHaveLength(0);
  });
});

describe("rating lookup", () => {
  it("returns stored ratings and defaults anyone missing", async () => {
    const { userIds } = await makeParty(handle, 2, { rating: 1500 });
    const ghost = "00000000-0000-0000-0000-000000000000";

    const ratings = await lifecycle.ratingsFor([...userIds, ghost]);
    expect(ratings.get(userIds[0]!)).toBe(1500);
    expect(ratings.get(ghost)).toBe(1200);
  });
});

describe("client view", () => {
  it("returns full rosters, not bare participant rows", async () => {
    const { decision } = await stageMatch();
    const created = await lifecycle.createFromDecision(decision, "na");
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const view = await lifecycle.view(created.data.matchId);

    // The roster components index into these unconditionally; anything less
    // than a drawable team takes the whole client down.
    expect(view!.team1).toHaveLength(5);
    expect(view!.team2).toHaveLength(5);
    expect(view!.captain1).toBeTruthy();
    expect(view!.captain2).toBeTruthy();

    for (const p of [...view!.team1, ...view!.team2]) {
      expect(p.id).toBeTruthy();
      expect(p.discordName).toBeTruthy();
      expect(p.inGameName).toBeTruthy();
      expect(typeof p.rating).toBe("number");
      expect(p.accepted).toBe(false);
    }
  });

  it("hides the tier of a player still in placements", async () => {
    const { decision } = await stageMatch();
    const created = await lifecycle.createFromDecision(decision, "na");
    if (!isOk(created)) throw new Error("staging failed");

    const view = await lifecycle.view(created.data.matchId);
    // stageMatch's players have no games, so nobody is placed yet.
    expect([...view!.team1, ...view!.team2].every((p) => p.tier === null)).toBe(true);
  });

  it("reflects an accept", async () => {
    const { team1, decision } = await stageMatch();
    const created = await lifecycle.createFromDecision(decision, "na");
    if (!isOk(created)) throw new Error("staging failed");

    await lifecycle.accept(created.data.matchId, team1[0]!.userIds[0]!);

    const view = await lifecycle.view(created.data.matchId);
    const accepted = [...view!.team1, ...view!.team2].filter((p) => p.accepted);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.id).toBe(team1[0]!.userIds[0]);
  });

  it("serialises deadlines as strings so JSON round-trips unchanged", async () => {
    const { decision } = await stageMatch();
    const created = await lifecycle.createFromDecision(decision, "na");
    if (!isOk(created)) throw new Error("staging failed");

    const view = await lifecycle.view(created.data.matchId);
    expect(typeof view!.acceptDeadline).toBe("string");
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("returns null for a match that does not exist", async () => {
    expect(await lifecycle.view("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
