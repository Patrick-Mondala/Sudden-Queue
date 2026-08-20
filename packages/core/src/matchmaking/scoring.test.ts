import { describe, expect, it } from "vitest";

import { DEFAULT_RATING, MATCH_SIZE, TEAM_SIZE } from "../constants.js";
import {
  type QueueTicket,
  buildTeamOptions,
  candidateWindowForAnchor,
  coordinationScore,
  findBestMatch,
  findBestMatchForAnchor,
  isBetterCandidate,
  partySymmetryScore,
  scoreCandidate,
  sumTicketSizes,
  teamRating,
  teamShapeSignature,
} from "./scoring.js";

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

describe("candidate window", () => {
  it("excludes tickets outside the anchor's rating window", () => {
    const anchor = ticket(1, 1200);
    const near = ticket(1, 1250);
    const far = ticket(1, 2000);

    const window = candidateWindowForAnchor(anchor, [anchor, near, far], NOW);
    const ids = window.map((t) => t.partyId);

    expect(ids).toContain(near.partyId);
    expect(ids).not.toContain(far.partyId);
  });

  it("always keeps the anchor itself, first", () => {
    const anchor = ticket(1, 1200);
    const others = Array.from({ length: 30 }, () => ticket(1, 1210));
    const window = candidateWindowForAnchor(anchor, [...others, anchor], NOW);
    expect(window[0]!.partyId).toBe(anchor.partyId);
  });

  it("caps the window so the pair search cannot blow up", () => {
    const anchor = ticket(1, 1200);
    const crowd = Array.from({ length: 200 }, () => ticket(1, 1200));
    expect(candidateWindowForAnchor(anchor, [anchor, ...crowd], NOW, 14)).toHaveLength(14);
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
