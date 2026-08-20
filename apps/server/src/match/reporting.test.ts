import { K_CALIBRATION, K_PLACEMENT, isFail, isOk } from "@suddenqueue/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  disputes,
  matchParticipants,
  matches,
  playerRatings,
  ratingAdjustments,
} from "../db/schema/index.js";
import { QueueRepository } from "../queue/repository.js";
import { makeParty, makeUser, setupTestDatabase, truncateAll } from "../test/helpers.js";
import { MatchLifecycle } from "./lifecycle.js";
import { MatchReporting } from "./reporting.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let lifecycle: MatchLifecycle;
let reporting: MatchReporting;
let queue: QueueRepository;

beforeAll(async () => {
  handle = await setupTestDatabase();
  lifecycle = new MatchLifecycle(handle.db);
  reporting = new MatchReporting(handle.db);
  queue = new QueueRepository(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

/** Builds a live match and returns both captains plus every participant. */
async function liveMatch(opts: { rating?: number; games?: number; type?: "PUG" | "SCRIM" } = {}) {
  const rating = opts.rating ?? 1200;
  const games = opts.games ?? 30;

  const parties = [];
  for (let i = 0; i < 10; i += 1) {
    parties.push(await makeParty(handle, 1, { rating }));
  }
  for (const p of parties) {
    await queue.join({ partyId: p.partyId, regions: ["na"], ratingSnapshot: rating, size: 1 });
  }
  await handle.db.update(playerRatings).set({ gamesPlayed: games });

  const decision = {
    anchorPartyId: parties[0]!.partyId,
    team1PartyIds: parties.slice(0, 5).map((p) => p.partyId),
    team2PartyIds: parties.slice(5).map((p) => p.partyId),
    team1Rating: rating,
    team2Rating: rating,
    gap: 0,
    allowedGap: 100,
    symmetryScore: 0,
  };

  const created = await lifecycle.createFromDecision(decision, "na", opts.type ?? "PUG");
  if (!isOk(created)) throw new Error("failed to create match");

  await handle.db
    .update(matches)
    .set({ state: "LIVE" })
    .where(eq(matches.id, created.data.matchId));

  const parts = await lifecycle.participants(created.data.matchId);
  return {
    matchId: created.data.matchId,
    participants: parts,
    captain1: parts.find((p) => p.team === 1 && p.isCaptain)!.userId,
    captain2: parts.find((p) => p.team === 2 && p.isCaptain)!.userId,
    team1: parts.filter((p) => p.team === 1).map((p) => p.userId),
    team2: parts.filter((p) => p.team === 2).map((p) => p.userId),
  };
}

async function ratingOf(userId: string): Promise<number> {
  const [row] = await handle.db
    .select({ rating: playerRatings.rating })
    .from(playerRatings)
    .where(eq(playerRatings.userId, userId));
  return row!.rating;
}

describe("who may report", () => {
  it("rejects a non-captain", async () => {
    const m = await liveMatch();
    const nonCaptain = m.team1.find((u) => u !== m.captain1)!;

    const r = await reporting.report(m.matchId, nonCaptain, "TEAM1");
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("NOT_A_CAPTAIN");
  });

  it("rejects someone not in the match", async () => {
    const m = await liveMatch();
    const outsider = await makeUser(handle);

    const r = await reporting.report(m.matchId, outsider, "TEAM1");
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("NOT_A_CAPTAIN");
  });

  it("rejects reporting before the match is live", async () => {
    const m = await liveMatch();
    await handle.db
      .update(matches)
      .set({ state: "PENDING_ACCEPT" })
      .where(eq(matches.id, m.matchId));

    const r = await reporting.report(m.matchId, m.captain1, "TEAM1");
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("NOT_REPORTABLE");
  });
});

describe("one-sided report", () => {
  it("waits for the other captain and moves no rating", async () => {
    const m = await liveMatch();
    const before = await ratingOf(m.captain1);

    const r = await reporting.report(m.matchId, m.captain1, "TEAM1");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.state).toBe("REPORTED");
      expect(r.data.winner).toBeNull();
    }

    // Nothing may move until both sides agree.
    expect(await ratingOf(m.captain1)).toBe(before);
    const match = await lifecycle.getMatch(m.matchId);
    expect(match!.ratingApplied).toBe(false);
    expect(match!.reportDeadline).not.toBeNull();
  });

  it("lets a captain correct their own claim before the other reports", async () => {
    const m = await liveMatch();

    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain1, "TEAM2");

    // One captain is one opinion however many times they submit it.
    const reports = await reporting.reportsFor(m.matchId);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.claimedWinner).toBe("TEAM2");
  });
});

describe("agreement", () => {
  it("settles the match and applies rating both ways", async () => {
    const m = await liveMatch({ rating: 1200, games: 30 });
    const winnerBefore = await ratingOf(m.captain1);
    const loserBefore = await ratingOf(m.captain2);

    await reporting.report(m.matchId, m.captain1, "TEAM1");
    const final = await reporting.report(m.matchId, m.captain2, "TEAM1");

    expect(isOk(final)).toBe(true);
    if (!isOk(final)) return;
    expect(final.data.state).toBe("COMPLETED");
    expect(final.data.winner).toBe("TEAM1");

    expect(await ratingOf(m.captain1)).toBeGreaterThan(winnerBefore);
    expect(await ratingOf(m.captain2)).toBeLessThan(loserBefore);
  });

  it("moves half of K against an evenly matched opponent", async () => {
    const m = await liveMatch({ rating: 1200, games: 30 });

    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM1");

    // Steady-state K is 24, so an even win is +12.
    expect(await ratingOf(m.captain1)).toBe(1200 + 12);
    expect(await ratingOf(m.captain2)).toBe(1200 - 12);
  });

  it("uses the faster calibration K for a player still inside their first 20", async () => {
    const m = await liveMatch({ rating: 1200, games: 10 });

    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM1");

    expect(await ratingOf(m.captain1)).toBe(1200 + K_CALIBRATION / 2);
    expect(K_CALIBRATION).toBeGreaterThan(K_PLACEMENT);
  });

  it("records rating_before and rating_delta for every participant", async () => {
    const m = await liveMatch();
    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM1");

    const parts = await handle.db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, m.matchId));

    // These two columns are what make a later reversal exact.
    expect(parts).toHaveLength(10);
    for (const p of parts) {
      expect(p.ratingBefore).not.toBeNull();
      expect(p.ratingDelta).not.toBeNull();
    }
  });

  it("updates records, streaks and games played", async () => {
    const m = await liveMatch();
    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM1");

    const [winner] = await handle.db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.userId, m.captain1));
    const [loser] = await handle.db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.userId, m.captain2));

    expect(winner!.wins).toBe(1);
    expect(winner!.currentWinStreak).toBe(1);
    expect(winner!.gamesPlayed).toBe(31);
    expect(loser!.losses).toBe(1);
    expect(loser!.currentWinStreak).toBe(0);
  });

  it("is zero-sum across the two teams", async () => {
    const m = await liveMatch();
    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM1");

    const parts = await handle.db
      .select({ delta: matchParticipants.ratingDelta })
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, m.matchId));

    const total = parts.reduce((sum, p) => sum + (p.delta ?? 0), 0);
    expect(total).toBe(0);
  });

  it("refuses a further report once settled", async () => {
    const m = await liveMatch();
    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM1");

    const late = await reporting.report(m.matchId, m.captain1, "TEAM2");
    expect(isFail(late)).toBe(true);
    if (isFail(late)) expect(late.code).toBe("ALREADY_RESOLVED");
  });
});

describe("scrims are unrated", () => {
  it("records the winner but moves no rating", async () => {
    const m = await liveMatch({ type: "SCRIM" });
    const before = await ratingOf(m.captain1);

    await reporting.report(m.matchId, m.captain1, "TEAM1");
    const final = await reporting.report(m.matchId, m.captain2, "TEAM1");

    expect(isOk(final) && final.data.state).toBe("COMPLETED");
    expect(await ratingOf(m.captain1)).toBe(before);

    const match = await lifecycle.getMatch(m.matchId);
    expect(match!.result).toBe("TEAM1");
    expect(match!.ratingApplied).toBe(false);
  });
});

describe("disagreement", () => {
  it("opens a dispute and moves nothing", async () => {
    const m = await liveMatch();
    const before = await ratingOf(m.captain1);

    await reporting.report(m.matchId, m.captain1, "TEAM1");
    const clash = await reporting.report(m.matchId, m.captain2, "TEAM2");

    expect(isOk(clash) && clash.data.state).toBe("DISPUTED");

    // The cheap case: never applied beats applied-and-reversed.
    expect(await ratingOf(m.captain1)).toBe(before);
    const match = await lifecycle.getMatch(m.matchId);
    expect(match!.ratingApplied).toBe(false);
    expect(match!.result).toBeNull();

    const open = await reporting.openDisputes();
    expect(open).toHaveLength(1);
    expect(open[0]!.matchId).toBe(m.matchId);
  });

  it("counts the dispute against everyone involved", async () => {
    const m = await liveMatch();
    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM2");

    const [row] = await handle.db
      .select({ n: playerRatings.disputesInvolved })
      .from(playerRatings)
      .where(eq(playerRatings.userId, m.captain1));

    expect(row!.n).toBe(1);
  });

  it("a moderator ruling settles it and applies rating once", async () => {
    const m = await liveMatch();
    const before = await ratingOf(m.captain1);

    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM2");

    const mod = await makeUser(handle);
    const resolved = await reporting.resolveDispute(m.matchId, mod, "TEAM1", "Reviewed evidence");

    expect(isOk(resolved)).toBe(true);
    expect(await ratingOf(m.captain1)).toBe(before + 12);

    const [d] = await handle.db.select().from(disputes).where(eq(disputes.matchId, m.matchId));
    expect(d!.status).toBe("resolved");
    expect(d!.resolvedBy).toBe(mod);

    // Nothing was applied then undone, so the ledger stays empty.
    const adjustments = await handle.db.select().from(ratingAdjustments);
    expect(adjustments).toHaveLength(0);
  });

  it("refuses to resolve a match that is not in dispute", async () => {
    const m = await liveMatch();
    const mod = await makeUser(handle);

    const r = await reporting.resolveDispute(m.matchId, mod, "TEAM1", "no");
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("NOT_DISPUTED");
  });
});

describe("overturning an applied result", () => {
  /**
   * The expensive case: a result was agreed, rating moved, and only later was
   * the match disputed and ruled the other way. The inverse must be exact.
   */
  it("reverses through the ledger and lands on the corrected rating", async () => {
    const m = await liveMatch({ rating: 1200, games: 30 });
    const startWinner = await ratingOf(m.captain1);
    const startLoser = await ratingOf(m.captain2);

    // Both agree team 1 won, so rating applies.
    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM1");
    expect(await ratingOf(m.captain1)).toBe(startWinner + 12);

    // Later it is disputed and overturned.
    await handle.db
      .update(matches)
      .set({ state: "DISPUTED" })
      .where(eq(matches.id, m.matchId));
    await handle.db.insert(disputes).values({ matchId: m.matchId, reason: "Reopened" });

    const mod = await makeUser(handle);
    const resolved = await reporting.resolveDispute(m.matchId, mod, "TEAM2", "Overturned");
    expect(isOk(resolved)).toBe(true);

    // Net effect must be exactly the corrected outcome, not a drifted value.
    expect(await ratingOf(m.captain1)).toBe(startWinner - 12);
    expect(await ratingOf(m.captain2)).toBe(startLoser + 12);

    // And the correction is explained in the ledger rather than hidden.
    const adjustments = await handle.db.select().from(ratingAdjustments);
    expect(adjustments).toHaveLength(10);
    expect(adjustments.every((a) => a.reason === "Dispute resolution")).toBe(true);
    expect(adjustments.every((a) => a.appliedBy === mod)).toBe(true);
  });

  it("does not inflate games played when reversing", async () => {
    const m = await liveMatch({ games: 30 });

    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM1");

    await handle.db
      .update(matches)
      .set({ state: "DISPUTED" })
      .where(eq(matches.id, m.matchId));
    await handle.db.insert(disputes).values({ matchId: m.matchId, reason: "Reopened" });

    const mod = await makeUser(handle);
    await reporting.resolveDispute(m.matchId, mod, "TEAM2", "Overturned");

    const [row] = await handle.db
      .select({ n: playerRatings.gamesPlayed })
      .from(playerRatings)
      .where(eq(playerRatings.userId, m.captain1));

    // One match played, however many times it was settled.
    expect(row!.n).toBe(31);
  });
});

describe("history", () => {
  it("lists settled matches with the player's own delta", async () => {
    const m = await liveMatch();
    await reporting.report(m.matchId, m.captain1, "TEAM1");
    await reporting.report(m.matchId, m.captain2, "TEAM1");

    const history = await reporting.historyFor(m.captain1);
    expect(history).toHaveLength(1);
    expect(history[0]!.result).toBe("TEAM1");
    expect(history[0]!.team).toBe(1);
    expect(history[0]!.ratingDelta).toBe(12);
  });

  it("omits matches that are still in progress", async () => {
    const m = await liveMatch();
    expect(await reporting.historyFor(m.captain1)).toHaveLength(0);
  });
});
