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
 * pairing then squares it. The caller keeps the input window small; this is the
 * backstop.
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
 * Best valid match among `candidates` that includes `anchorPartyId` on one side.
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

  const anchorIndex = candidates.findIndex((t) => t.partyId === anchorPartyId);
  if (anchorIndex === -1) return null;

  const allIndices = candidates.map((_, i) => i);
  const team1Options = buildTeamOptions(candidates, allIndices);

  let bestScore: CandidateScore | null = null;
  let best: MatchDecision | null = null;

  for (const team1Indices of team1Options) {
    if (!team1Indices.includes(anchorIndex)) continue;

    const team1 = ticketsFromIndices(candidates, team1Indices);
    const rest = remainingIndices(candidates.length, team1Indices);
    const team2Options = buildTeamOptions(candidates, rest);

    for (const team2Indices of team2Options) {
      const team2 = ticketsFromIndices(candidates, team2Indices);
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
 * Narrows the pool to tickets worth pairing with the anchor before the
 * combinatorial step. Rating-bounded and hard-capped, since the pair search
 * scales roughly with the square of this list.
 */
export function candidateWindowForAnchor(
  anchor: QueueTicket,
  pool: readonly QueueTicket[],
  now: number,
  maxCandidates = 14,
): QueueTicket[] {
  const waited = Math.max(0, now - anchor.joinedAt);
  const allowed = allowedGapForWait(waited);

  return pool
    .filter(
      (t) =>
        t.partyId === anchor.partyId ||
        Math.abs(t.ratingSnapshot - anchor.ratingSnapshot) <= allowed,
    )
    .sort((a, b) => {
      if (a.partyId === anchor.partyId) return -1;
      if (b.partyId === anchor.partyId) return 1;
      const da = Math.abs(a.ratingSnapshot - anchor.ratingSnapshot);
      const db = Math.abs(b.ratingSnapshot - anchor.ratingSnapshot);
      return da === db ? a.joinedAt - b.joinedAt : da - db;
    })
    .slice(0, maxCandidates);
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
