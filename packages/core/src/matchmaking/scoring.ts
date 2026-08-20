/**
 * Match scoring — ported from the earlier system's matchmaking maths.
 *
 * Pure and side-effect free: everything here operates on plain ticket objects,
 * so the whole matchmaker is testable without a database.
 *
 * A "ticket" is one queued party. A "candidate" is a pair of teams that together
 * fill a match. The matchmaker enumerates candidates, scores them, and keeps the
 * best.
 */

import { MATCH_SIZE, TEAM_SIZE } from "../constants.js";
import { allowedGapForWait } from "../rating/elo.js";

export interface QueueTicket {
  partyId: string;
  /** Number of players in the party. */
  size: number;
  /** Rating frozen at queue-join, so mid-queue changes cannot shift the search. */
  ratingSnapshot: number;
  /** Epoch seconds. */
  joinedAt: number;
}

export interface CandidateScore {
  team1Rating: number;
  team2Rating: number;
  gap: number;
  allowedGap: number;
  /** One join time per party (not per player), ascending. Drives the fairness tie-break. */
  joinedTimes: number[];
  symmetryScore: number;
}

export interface MatchDecision {
  anchorPartyId: string;
  team1PartyIds: string[];
  team2PartyIds: string[];
  team1Rating: number;
  team2Rating: number;
  gap: number;
  allowedGap: number;
  symmetryScore: number;
}

export function sumTicketSizes(tickets: readonly QueueTicket[]): number {
  return tickets.reduce((total, t) => total + t.size, 0);
}

/** Player-weighted mean rating for a team. */
export function teamRating(tickets: readonly QueueTicket[], fallback: number): number {
  const players = sumTicketSizes(tickets);
  if (players <= 0) return fallback;
  const weighted = tickets.reduce((sum, t) => sum + t.ratingSnapshot * t.size, 0);
  return Math.floor(weighted / players + 0.5);
}

/** Party sizes descending, e.g. "3-1-1". Human-readable team shape. */
export function teamShapeSignature(tickets: readonly QueueTicket[]): string {
  return [...tickets]
    .map((t) => t.size)
    .sort((a, b) => b - a)
    .join("-");
}

/**
 * How much of a team already plays together, as the count of pre-coordinated
 * pairs: the sum of C(size, 2) across its parties.
 *
 * The earlier version hard-coded a lookup table of shape pairs, which only
 * covered 3-player teams ("2-1" vs "1-1-1" and so on). Five-player teams have
 * seven partitions instead of three, so that table would have needed 21 entries
 * written by hand.
 *
 * This formula replaces it and is not an approximation — it reproduces the
 * original table exactly for 3-player teams (see the tests), because that table
 * was itself encoding coordinated-pair difference. It just generalises to any
 * team size.
 *
 *   5          -> 10      3-1-1     -> 3
 *   4-1        ->  6      2-2-1     -> 2
 *   3-2        ->  4      2-1-1-1   -> 1
 *                         1-1-1-1-1 -> 0
 */
export function coordinationScore(tickets: readonly QueueTicket[]): number {
  return tickets.reduce((sum, t) => sum + (t.size * (t.size - 1)) / 2, 0);
}

/**
 * How lopsided the premade advantage is between two teams. 0 means both sides
 * are equally coordinated; higher is more unfair. The matchmaker prefers lower.
 */
export function partySymmetryScore(
  team1: readonly QueueTicket[],
  team2: readonly QueueTicket[],
): number {
  return Math.abs(coordinationScore(team1) - coordinationScore(team2));
}

export function sortedJoinedTimes(
  team1: readonly QueueTicket[],
  team2: readonly QueueTicket[],
): number[] {
  return [...team1, ...team2].map((t) => t.joinedAt).sort((a, b) => a - b);
}

export function oldestJoinedTime(
  team1: readonly QueueTicket[],
  team2: readonly QueueTicket[],
): number | null {
  const times = [...team1, ...team2].map((t) => t.joinedAt);
  return times.length === 0 ? null : Math.min(...times);
}

/** Bundles every metric needed to compare two candidates. */
export function scoreCandidate(
  team1: readonly QueueTicket[],
  team2: readonly QueueTicket[],
  now: number,
  defaultRating: number,
): CandidateScore {
  const team1Rating = teamRating(team1, defaultRating);
  const team2Rating = teamRating(team2, defaultRating);
  const oldest = oldestJoinedTime(team1, team2);
  const waited = oldest === null ? 0 : Math.max(0, now - oldest);

  return {
    team1Rating,
    team2Rating,
    gap: Math.abs(team1Rating - team2Rating),
    allowedGap: allowedGapForWait(waited),
    joinedTimes: sortedJoinedTimes(team1, team2),
    symmetryScore: partySymmetryScore(team1, team2),
  };
}

/**
 * Ranking, in priority order:
 *   1. Serve the longest-waiting players first (lexicographic on join times)
 *   2. Then the closest rating match
 *   3. Then the fairest premade balance
 *
 * Wait time outranks quality deliberately — a queue that never pops is worse
 * than one that occasionally pops slightly uneven.
 */
export function isBetterCandidate(
  candidate: CandidateScore,
  best: CandidateScore | null,
): boolean {
  if (best === null) return true;

  const len = Math.max(candidate.joinedTimes.length, best.joinedTimes.length);
  for (let i = 0; i < len; i += 1) {
    const a = candidate.joinedTimes[i] ?? Number.POSITIVE_INFINITY;
    const b = best.joinedTimes[i] ?? Number.POSITIVE_INFINITY;
    if (a !== b) return a < b;
  }

  if (candidate.gap !== best.gap) return candidate.gap < best.gap;
  return candidate.symmetryScore < best.symmetryScore;
}

/**
 * Every combination of ticket indices whose sizes total exactly TEAM_SIZE.
 *
 * `limit` caps the result because the search is combinatorial and TEAM_SIZE
 * doubled from the earlier version: with twenty solo tickets, 3v3 enumerated
 * about 1,100 team options where 5v5 enumerates over 15,000, and the candidate
 * pairing then squares it.
 *
 * NOT used by the live matchmaker for that reason — findBestMatchForAnchor
 * searches party shapes instead. Kept because exhaustive enumeration is the
 * ground truth the shape search is tested against: if a feasible match exists,
 * the fast path must find one too.
 */
export function buildTeamOptions(
  tickets: readonly QueueTicket[],
  fromIndices: readonly number[],
  limit = 20_000,
): number[][] {
  const out: number[][] = [];
  const current: number[] = [];

  const walk = (start: number, filled: number): void => {
    if (out.length >= limit) return;
    if (filled === TEAM_SIZE) {
      out.push([...current]);
      return;
    }
    if (filled > TEAM_SIZE) return;

    for (let i = start; i < fromIndices.length; i += 1) {
      const idx = fromIndices[i]!;
      const ticket = tickets[idx]!;
      if (filled + ticket.size > TEAM_SIZE) continue;

      current.push(idx);
      walk(i + 1, filled + ticket.size);
      current.pop();

      if (out.length >= limit) return;
    }
  };

  walk(0, 0);
  return out;
}

export function ticketsFromIndices(
  tickets: readonly QueueTicket[],
  indices: readonly number[],
): QueueTicket[] {
  return indices.map((i) => tickets[i]!);
}

export function remainingIndices(total: number, used: readonly number[]): number[] {
  const taken = new Set(used);
  const out: number[] = [];
  for (let i = 0; i < total; i += 1) if (!taken.has(i)) out.push(i);
  return out;
}

/**
 * Every way to partition `total` into descending parts of at most `maxPart`.
 * For TEAM_SIZE 5 this is the seven team shapes: 5, 4-1, 3-2, 3-1-1, 2-2-1,
 * 2-1-1-1, 1-1-1-1-1.
 */
export function partitionsOf(total: number, maxPart: number = total): number[][] {
  if (total === 0) return [[]];
  const out: number[][] = [];
  for (let part = Math.min(maxPart, total); part >= 1; part -= 1) {
    for (const rest of partitionsOf(total - part, part)) {
      out.push([part, ...rest]);
    }
  }
  return out;
}

/** The seven shapes a five-player team can take. Computed once. */
export const TEAM_SHAPES: readonly (readonly number[])[] = partitionsOf(TEAM_SIZE);

/** Tickets grouped by party size, each group sorted by rating ascending. */
function bucketBySize(tickets: readonly QueueTicket[]): Map<number, QueueTicket[]> {
  const buckets = new Map<number, QueueTicket[]>();
  for (const t of tickets) {
    const list = buckets.get(t.size);
    if (list) list.push(t);
    else buckets.set(t.size, [t]);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => a.ratingSnapshot - b.ratingSnapshot);
  }
  return buckets;
}

/**
 * Takes the party of the given size whose rating sits closest to `target`,
 * removing it from the bucket. Returns null when that size is exhausted.
 */
function takeNearest(
  buckets: Map<number, QueueTicket[]>,
  size: number,
  target: number,
): QueueTicket | null {
  const list = buckets.get(size);
  if (!list || list.length === 0) return null;

  let bestIndex = 0;
  let bestDistance = Math.abs(list[0]!.ratingSnapshot - target);
  for (let i = 1; i < list.length; i += 1) {
    const d = Math.abs(list[i]!.ratingSnapshot - target);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }
  return list.splice(bestIndex, 1)[0]!;
}

/** Fills one shape from the buckets, aiming each pick at `target`. */
function fillShape(
  shape: readonly number[],
  buckets: Map<number, QueueTicket[]>,
  target: number,
): QueueTicket[] | null {
  const picked: QueueTicket[] = [];
  for (const size of shape) {
    const t = takeNearest(buckets, size, target);
    if (t === null) return null;
    picked.push(t);
  }
  return picked;
}

/**
 * Best valid match among `candidates` that includes `anchorPartyId` on one side.
 *
 * Searches the 7x7 grid of team shapes rather than every subset of tickets.
 * Enumerating player combinations is what does not scale: forty solo tickets
 * give roughly 82,000 anchored team-1 options against 325,000 team-2 options.
 * There are only ever seven shapes per side, whatever the queue size.
 *
 * Within a shape, parties are chosen by rating proximity, so the shape grid
 * decides feasibility and the greedy pick decides quality. Feasibility is never
 * traded away for speed — every shape is always tried, so no party is excluded
 * for being the wrong size.
 *
 * Anchoring on the longest-waiting ticket is what stops a party being starved
 * while newer, easier-to-pair parties keep jumping ahead of it.
 */
export function findBestMatchForAnchor(
  candidates: readonly QueueTicket[],
  anchorPartyId: string,
  now: number,
  defaultRating: number,
): MatchDecision | null {
  if (sumTicketSizes(candidates) < MATCH_SIZE) return null;

  const anchor = candidates.find((t) => t.partyId === anchorPartyId);
  if (!anchor) return null;

  const others = candidates.filter((t) => t.partyId !== anchorPartyId);

  let bestScore: CandidateScore | null = null;
  let best: MatchDecision | null = null;

  for (const shape1 of TEAM_SHAPES) {
    // The anchor has to occupy one of team 1's slots, so its size must appear.
    if (!shape1.includes(anchor.size)) continue;

    for (const shape2 of TEAM_SHAPES) {
      const buckets = bucketBySize(others);

      // Anchor consumes one slot of its own size.
      const remainingShape1 = [...shape1];
      remainingShape1.splice(remainingShape1.indexOf(anchor.size), 1);

      const rest1 = fillShape(remainingShape1, buckets, anchor.ratingSnapshot);
      if (rest1 === null) continue;

      const team1 = [anchor, ...rest1];
      const team1Rating = teamRating(team1, defaultRating);

      // Aim team 2 at team 1's average so the gap closes rather than drifts.
      const team2 = fillShape(shape2, buckets, team1Rating);
      if (team2 === null) continue;

      const score = scoreCandidate(team1, team2, now, defaultRating);
      if (score.gap > score.allowedGap) continue;
      if (!isBetterCandidate(score, bestScore)) continue;

      bestScore = score;
      best = {
        anchorPartyId,
        team1PartyIds: team1.map((t) => t.partyId),
        team2PartyIds: team2.map((t) => t.partyId),
        team1Rating: score.team1Rating,
        team2Rating: score.team2Rating,
        gap: score.gap,
        allowedGap: score.allowedGap,
        symmetryScore: score.symmetryScore,
      };
    }
  }

  return best;
}

/**
 * Tickets the anchor is currently allowed to be matched with.
 *
 * Rating-bounded only — deliberately uncapped in count. The bound widens with
 * wait time and exceeds the full ladder spread after a few minutes, so a
 * long-waiting party eventually becomes eligible to match anyone rather than
 * sitting in a queue that never pops.
 */
export function candidateWindowForAnchor(
  anchor: QueueTicket,
  pool: readonly QueueTicket[],
  now: number,
): QueueTicket[] {
  const waited = Math.max(0, now - anchor.joinedAt);
  const allowed = allowedGapForWait(waited);

  return pool.filter(
    (t) =>
      t.partyId === anchor.partyId ||
      Math.abs(t.ratingSnapshot - anchor.ratingSnapshot) <= allowed,
  );
}

/**
 * One matchmaking pass. Tries each ticket as the anchor, oldest first, and
 * returns the first valid match found.
 */
export function findBestMatch(
  pool: readonly QueueTicket[],
  now: number,
  defaultRating: number,
): MatchDecision | null {
  const byWait = [...pool].sort((a, b) => a.joinedAt - b.joinedAt);

  for (const anchor of byWait) {
    const window = candidateWindowForAnchor(anchor, byWait, now);
    const decision = findBestMatchForAnchor(window, anchor.partyId, now, defaultRating);
    if (decision) return decision;
  }

  return null;
}
