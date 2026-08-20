import { describe, expect, it } from "vitest";

import { DEFAULT_RATING, MATCH_SIZE, TEAM_SIZE } from "../constants.js";
import {
  type QueueTicket,
  TEAM_SHAPES,
  buildTeamOptions,
  candidateWindowForAnchor,
  coordinationScore,
  findBestMatch,
  findBestMatchForAnchor,
  isBetterCandidate,
  partitionsOf,
  partySymmetryScore,
  remainingIndices,
  scoreCandidate,
  sumTicketSizes,
  teamRating,
  teamShapeSignature,
  ticketsFromIndices,
} from "./scoring.js";

/**
 * Ground truth: exhaustively checks whether ANY valid 5v5 exists in the pool
 * containing the anchor, ignoring rating entirely. Too slow for production,
 * which is the whole reason the shape search exists — but perfect as an oracle.
 */
function feasibleByBruteForce(pool: QueueTicket[], anchorId: string): boolean {
  const anchorIndex = pool.findIndex((t) => t.partyId === anchorId);
  if (anchorIndex === -1) return false;

  for (const t1 of buildTeamOptions(pool, pool.map((_, i) => i))) {
    if (!t1.includes(anchorIndex)) continue;
    const rest = remainingIndices(pool.length, t1);
    if (buildTeamOptions(pool, rest).length > 0) return true;
  }
  return false;
}

const NOW = 1_000_000;

let seq = 0;
function ticket(size: number, rating = DEFAULT_RATING, ageSeconds = 0): QueueTicket {
  seq += 1;
  return {
    partyId: `p${seq}`,
    size,
    ratingSnapshot: rating,
    joinedAt: NOW - ageSeconds,
  };
}

/** Builds a team from party sizes, e.g. team(3, 1, 1). */
function team(...sizes: number[]): QueueTicket[] {
  return sizes.map((s) => ticket(s));
}

describe("coordination score", () => {
  it("counts pre-coordinated pairs for every 5-player shape", () => {
    expect(coordinationScore(team(5))).toBe(10);
    expect(coordinationScore(team(4, 1))).toBe(6);
    expect(coordinationScore(team(3, 2))).toBe(4);
    expect(coordinationScore(team(3, 1, 1))).toBe(3);
    expect(coordinationScore(team(2, 2, 1))).toBe(2);
    expect(coordinationScore(team(2, 1, 1, 1))).toBe(1);
    expect(coordinationScore(team(1, 1, 1, 1, 1))).toBe(0);
  });

  it("orders shapes from fully premade to fully solo", () => {
    const shapes = [
      team(5),
      team(4, 1),
      team(3, 2),
      team(3, 1, 1),
      team(2, 2, 1),
      team(2, 1, 1, 1),
      team(1, 1, 1, 1, 1),
    ].map(coordinationScore);

    for (let i = 1; i < shapes.length; i += 1) {
      expect(shapes[i]!).toBeLessThan(shapes[i - 1]!);
    }
  });
});

describe("party symmetry", () => {
  it("is zero for identically shaped teams", () => {
    expect(partySymmetryScore(team(3, 2), team(3, 2))).toBe(0);
    expect(partySymmetryScore(team(1, 1, 1, 1, 1), team(1, 1, 1, 1, 1))).toBe(0);
  });

  it("is symmetric", () => {
    const a = team(5);
    const b = team(2, 1, 1, 1);
    expect(partySymmetryScore(a, b)).toBe(partySymmetryScore(b, a));
  });

  it("penalises a full premade against solos most heavily", () => {
    const premadeVsSolos = partySymmetryScore(team(5), team(1, 1, 1, 1, 1));
    const nearlyEven = partySymmetryScore(team(2, 2, 1), team(2, 1, 1, 1));
    expect(premadeVsSolos).toBeGreaterThan(nearlyEven);
  });

  /**
   * The earlier implementation hard-coded a lookup table for 3-player teams.
   * The formula that replaces it must not change existing behaviour, so this
   * pins it against the original values.
   */
  it("reproduces the original 3-player lookup table exactly", () => {
    const originalTable: Array<[number[], number[], number]> = [
      [[3], [3], 0],
      [[2, 1], [2, 1], 0],
      [[1, 1, 1], [1, 1, 1], 0],
      [[2, 1], [1, 1, 1], 1],
      [[3], [2, 1], 2],
      [[3], [1, 1, 1], 3],
    ];

    for (const [a, b, expected] of originalTable) {
      expect(partySymmetryScore(team(...a), team(...b))).toBe(expected);
    }
  });
});

describe("team rating", () => {
  it("weights by party size, not party count", () => {
    // A 4-stack at 1000 plus a solo at 1500 is not 1250.
    const t = [ticket(4, 1000), ticket(1, 1500)];
    expect(teamRating(t, DEFAULT_RATING)).toBe(1100);
  });

  it("falls back on an empty team", () => {
    expect(teamRating([], DEFAULT_RATING)).toBe(DEFAULT_RATING);
  });
});

describe("team shape signature", () => {
  it("sorts descending", () => {
    expect(teamShapeSignature(team(1, 3, 1))).toBe("3-1-1");
    expect(teamShapeSignature(team(5))).toBe("5");
  });
});

describe("candidate ranking", () => {
  function score(joined: number[], gap: number, symmetry: number) {
    return {
      team1Rating: 1200,
      team2Rating: 1200 + gap,
      gap,
      allowedGap: 500,
      joinedTimes: joined,
      symmetryScore: symmetry,
    };
  }

  it("prefers anything over nothing", () => {
    expect(isBetterCandidate(score([1], 0, 0), null)).toBe(true);
  });

  it("serves the longest-waiting player first, even at a worse rating gap", () => {
    const olderButLooser = score([100, 200], 400, 0);
    const newerButTighter = score([150, 200], 0, 0);
    expect(isBetterCandidate(olderButLooser, newerButTighter)).toBe(true);
  });

  it("falls back to rating gap when wait times tie", () => {
    expect(isBetterCandidate(score([100], 10, 0), score([100], 50, 0))).toBe(true);
    expect(isBetterCandidate(score([100], 50, 0), score([100], 10, 0))).toBe(false);
  });

  it("falls back to premade balance when wait and gap both tie", () => {
    expect(isBetterCandidate(score([100], 10, 1), score([100], 10, 6))).toBe(true);
  });
});

describe("team enumeration", () => {
  it("only produces teams that exactly fill a side", () => {
    const pool = [ticket(1), ticket(1), ticket(2), ticket(3), ticket(4), ticket(5)];
    const options = buildTeamOptions(pool, pool.map((_, i) => i));

    expect(options.length).toBeGreaterThan(0);
    for (const opt of options) {
      expect(sumTicketSizes(opt.map((i) => pool[i]!))).toBe(TEAM_SIZE);
    }
  });

  it("finds every 5-player combination in a solo-only pool", () => {
    const pool = Array.from({ length: 6 }, () => ticket(1));
    // C(6,5) = 6
    expect(buildTeamOptions(pool, pool.map((_, i) => i))).toHaveLength(6);
  });

  it("respects the enumeration cap", () => {
    const pool = Array.from({ length: 20 }, () => ticket(1));
    const capped = buildTeamOptions(pool, pool.map((_, i) => i), 50);
    expect(capped).toHaveLength(50);
  });
});

describe("finding a match", () => {
  it("returns null when there are not enough players", () => {
    const pool = [ticket(1), ticket(1), ticket(1)];
    expect(findBestMatch(pool, NOW, DEFAULT_RATING)).toBeNull();
  });

  it("builds a full 5v5 from ten solos", () => {
    const pool = Array.from({ length: 10 }, () => ticket(1));
    const decision = findBestMatch(pool, NOW, DEFAULT_RATING);

    expect(decision).not.toBeNull();
    expect(decision!.team1PartyIds).toHaveLength(5);
    expect(decision!.team2PartyIds).toHaveLength(5);

    const all = [...decision!.team1PartyIds, ...decision!.team2PartyIds];
    expect(new Set(all).size).toBe(MATCH_SIZE);
  });

  it("mixes parties and solos into full teams", () => {
    const pool = [
      ticket(3, 1200),
      ticket(2, 1200),
      ticket(2, 1200),
      ticket(2, 1200),
      ticket(1, 1200),
    ];
    const decision = findBestMatch(pool, NOW, DEFAULT_RATING);

    expect(decision).not.toBeNull();
    const t1 = decision!.team1PartyIds.length;
    const t2 = decision!.team2PartyIds.length;
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBeGreaterThan(0);
    // Every party used exactly once.
    expect(new Set([...decision!.team1PartyIds, ...decision!.team2PartyIds]).size).toBe(t1 + t2);
  });

  it("refuses a match whose rating gap exceeds the wait-widened window", () => {
    // Fresh tickets: window is only +/-100, but the sides are 800 apart.
    const pool = [
      ...Array.from({ length: 5 }, () => ticket(1, 1000)),
      ...Array.from({ length: 5 }, () => ticket(1, 1800)),
    ];
    expect(findBestMatch(pool, NOW, DEFAULT_RATING)).toBeNull();
  });

  it("accepts that same gap once the parties have waited long enough", () => {
    // 300s of waiting widens the window to 100 + 30*50 = 1600.
    const pool = [
      ...Array.from({ length: 5 }, () => ticket(1, 1000, 300)),
      ...Array.from({ length: 5 }, () => ticket(1, 1800, 300)),
    ];
    const decision = findBestMatch(pool, NOW, DEFAULT_RATING);
    expect(decision).not.toBeNull();
    expect(decision!.gap).toBeLessThanOrEqual(decision!.allowedGap);
  });

  it("anchors on the longest-waiting party", () => {
    const stale = ticket(1, 1200, 600);
    const fresh = Array.from({ length: 9 }, () => ticket(1, 1200, 1));
    const decision = findBestMatch([...fresh, stale], NOW, DEFAULT_RATING);

    expect(decision).not.toBeNull();
    const all = [...decision!.team1PartyIds, ...decision!.team2PartyIds];
    expect(all).toContain(stale.partyId);
  });

  it("keeps a party intact on one side rather than splitting it", () => {
    const stack = ticket(5, 1200);
    const solos = Array.from({ length: 5 }, () => ticket(1, 1200));
    const decision = findBestMatchForAnchor(
      [stack, ...solos],
      stack.partyId,
      NOW,
      DEFAULT_RATING,
    );

    expect(decision).not.toBeNull();
    const side = decision!.team1PartyIds.includes(stack.partyId)
      ? decision!.team1PartyIds
      : decision!.team2PartyIds;
    expect(side).toEqual([stack.partyId]);
  });
});

describe("team shapes", () => {
  it("finds all seven ways to fill a five-player team", () => {
    expect(TEAM_SHAPES).toHaveLength(7);
    expect(TEAM_SHAPES.map((s) => s.join("-"))).toEqual([
      "5",
      "4-1",
      "3-2",
      "3-1-1",
      "2-2-1",
      "2-1-1-1",
      "1-1-1-1-1",
    ]);
  });

  it("every shape totals a full team", () => {
    for (const shape of TEAM_SHAPES) {
      expect(shape.reduce((a, b) => a + b, 0)).toBe(TEAM_SIZE);
    }
  });

  it("generalises to other sizes", () => {
    expect(partitionsOf(3).map((s) => s.join("-"))).toEqual(["3", "2-1", "1-1-1"]);
    expect(partitionsOf(4)).toHaveLength(5);
  });
});

describe("candidate window", () => {
  it("excludes tickets outside the anchor's rating window", () => {
    const anchor = ticket(1, 1200);
    const near = ticket(1, 1250);
    const far = ticket(1, 2000);

    const ids = candidateWindowForAnchor(anchor, [anchor, near, far], NOW).map((t) => t.partyId);
    expect(ids).toContain(near.partyId);
    expect(ids).not.toContain(far.partyId);
  });

  it("always keeps the anchor itself", () => {
    const anchor = ticket(1, 1200);
    const others = Array.from({ length: 30 }, () => ticket(1, 1210));
    const ids = candidateWindowForAnchor(anchor, [...others, anchor], NOW).map((t) => t.partyId);
    expect(ids).toContain(anchor.partyId);
  });

  it("is never truncated by count, so the queue cannot stall on pool size", () => {
    const anchor = ticket(1, 1200);
    const crowd = Array.from({ length: 200 }, () => ticket(1, 1200));
    expect(candidateWindowForAnchor(anchor, [anchor, ...crowd], NOW)).toHaveLength(201);
  });

  it("eventually widens past the whole ladder, so any rank can match any rank", () => {
    // F- floor 620 to S+ floor 1720 is an 1100-point spread.
    const bottom = ticket(1, 620, 300);
    const top = ticket(1, 1720, 300);
    const ids = candidateWindowForAnchor(bottom, [bottom, top], NOW).map((t) => t.partyId);
    expect(ids).toContain(top.partyId);
  });
});

describe("no stalling on party shape", () => {
  /**
   * The failure the old rating-proximity cap could produce: a pool with plenty
   * of players but whose nearest-rated members cannot tile into two teams.
   */
  it("finds a match when close-rated parties cannot tile but distant ones can", () => {
    const anchor = ticket(1, 1200);
    const unusable = Array.from({ length: 13 }, () => ticket(3, 1201));
    const usable = Array.from({ length: 20 }, () => ticket(1, 1260));

    const pool = [anchor, ...unusable, ...usable];
    const decision = findBestMatchForAnchor(pool, anchor.partyId, NOW, DEFAULT_RATING);

    expect(decision).not.toBeNull();
    const all = [...decision!.team1PartyIds, ...decision!.team2PartyIds];
    expect(all).toContain(anchor.partyId);
  });

  it("matches a queue of nothing but 5-stacks", () => {
    const pool = [ticket(5, 1200), ticket(5, 1205)];
    const decision = findBestMatch(pool, NOW, DEFAULT_RATING);
    expect(decision).not.toBeNull();
    expect(decision!.team1PartyIds).toHaveLength(1);
    expect(decision!.team2PartyIds).toHaveLength(1);
  });

  it("matches awkward shapes that need different tilings per side", () => {
    // 4-1 against 3-2: no single shape works for both.
    const pool = [ticket(4, 1200), ticket(1, 1200), ticket(3, 1200), ticket(2, 1200)];
    const decision = findBestMatch(pool, NOW, DEFAULT_RATING);
    expect(decision).not.toBeNull();
    expect(sumTicketSizes(pool.filter((t) => decision!.team1PartyIds.includes(t.partyId)))).toBe(
      TEAM_SIZE,
    );
  });

  /**
   * The property that matters: the fast path must not miss matches that exist.
   * Ratings are held equal so only shape feasibility is under test.
   */
  it("finds a match whenever exhaustive search says one exists", () => {
    const sizePool = [1, 1, 1, 2, 2, 3, 4, 5];
    let checked = 0;

    for (let trial = 0; trial < 60; trial += 1) {
      const sizes = Array.from(
        { length: 4 + (trial % 5) },
        (_, i) => sizePool[(trial * 3 + i * 5) % sizePool.length]!,
      );
      const pool = sizes.map((s) => ticket(s, 1200));
      const anchorId = pool[0]!.partyId;

      if (!feasibleByBruteForce(pool, anchorId)) continue;
      checked += 1;

      const decision = findBestMatchForAnchor(pool, anchorId, NOW, DEFAULT_RATING);
      expect(decision, `shapes ${sizes.join(",")} are tileable but no match was found`).not.toBeNull();
    }

    // Guard against the loop silently testing nothing.
    expect(checked).toBeGreaterThan(5);
  });
});

describe("scales with queue size", () => {
  const sizes = [1, 1, 1, 1, 2, 2, 3, 5];

  function pool(n: number, spread: number): QueueTicket[] {
    return Array.from({ length: n }, (_, i) => ({
      partyId: `x${i}`,
      size: sizes[i % sizes.length]!,
      ratingSnapshot: 1000 + ((i * 37) % spread),
      joinedAt: NOW - 60,
    }));
  }

  it("completes a single pass over 500 parties well inside the tick interval", () => {
    const t0 = performance.now();
    findBestMatch(pool(500, 700), NOW, DEFAULT_RATING);
    const ms = performance.now() - t0;

    // The live loop runs every 2s. Brute-force enumeration could not do this at
    // any queue size; shape search is effectively flat in party count.
    expect(ms).toBeLessThan(250);
  });

  it("drains a 200-solo queue into 20 full matches", () => {
    let cur: QueueTicket[] = Array.from({ length: 200 }, (_, i) => ({
      partyId: `s${i}`,
      size: 1,
      ratingSnapshot: 1150 + (i % 100),
      joinedAt: NOW - 60,
    }));

    let matches = 0;
    for (;;) {
      const d = findBestMatch(cur, NOW, DEFAULT_RATING);
      if (!d) break;
      const ids = new Set([...d.team1PartyIds, ...d.team2PartyIds]);
      cur = cur.filter((t) => !ids.has(t.partyId));
      matches += 1;
      if (matches > 25) break;
    }

    expect(matches).toBe(20);
    expect(cur).toHaveLength(0);
  });
});

describe("repeated passes", () => {
  it("produces disjoint matches when drained repeatedly", () => {
    let pool = Array.from({ length: 30 }, () => ticket(1, 1200, 10));
    const used = new Set<string>();
    let matches = 0;

    for (let pass = 0; pass < 5; pass += 1) {
      const decision = findBestMatch(pool, NOW, DEFAULT_RATING);
      if (!decision) break;

      const ids = [...decision.team1PartyIds, ...decision.team2PartyIds];
      expect(ids).toHaveLength(MATCH_SIZE);
      for (const id of ids) {
        // No party may be pulled into two matches.
        expect(used.has(id)).toBe(false);
        used.add(id);
      }

      pool = pool.filter((t) => !ids.includes(t.partyId));
      matches += 1;
    }

    expect(matches).toBe(3);
    expect(used.size).toBe(30);
  });

  it("scores a realistic mixed queue within its allowed gap", () => {
    const pool = [
      ticket(2, 1180, 45),
      ticket(3, 1220, 40),
      ticket(1, 1195, 35),
      ticket(2, 1240, 30),
      ticket(1, 1210, 25),
      ticket(1, 1190, 20),
    ];
    const decision = findBestMatch(pool, NOW, DEFAULT_RATING);

    expect(decision).not.toBeNull();
    expect(decision!.gap).toBeLessThanOrEqual(decision!.allowedGap);

    const t1 = pool.filter((t) => decision!.team1PartyIds.includes(t.partyId));
    const t2 = pool.filter((t) => decision!.team2PartyIds.includes(t.partyId));
    const score = scoreCandidate(t1, t2, NOW, DEFAULT_RATING);

    // One join time per party, and the parties together field a full match.
    expect(score.joinedTimes).toHaveLength(t1.length + t2.length);
    expect(sumTicketSizes(t1) + sumTicketSizes(t2)).toBe(MATCH_SIZE);
    expect(sumTicketSizes(t1)).toBe(TEAM_SIZE);
  });
});
