import {
  MISSED_ACCEPT_COOLDOWNS_SECONDS,
  MISSED_ACCEPT_DECAY_SECONDS,
} from "./constants.js";

/**
 * Queue penalties for missing an accept.
 *
 * A missed accept costs nine other people their match, so it has to cost the
 * person who missed it something. The schedule escalates within a session and
 * forgives across days: the thing worth deterring is someone sitting on the
 * prompt and picking their matches, not someone whose app crashed once.
 */

export interface MissedAcceptState {
  /** Consecutive recent offences, before this one. */
  recent: number;
  /** When the last one happened, if there was one. */
  lastAt: Date | null;
}

export interface MissedAcceptPenalty {
  /** The offence count to store, after decay is applied. */
  offence: number;
  cooldownSeconds: number;
  cooldownUntil: Date;
}

/**
 * Works out what this miss costs.
 *
 * Decay is applied first, so a long-clean player is treated as a first offender
 * however many they racked up during a bad night months ago.
 */
export function missedAcceptPenalty(
  state: MissedAcceptState,
  now: Date = new Date(),
): MissedAcceptPenalty {
  const decayed =
    state.lastAt !== null &&
    now.getTime() - state.lastAt.getTime() < MISSED_ACCEPT_DECAY_SECONDS * 1000;

  const offence = (decayed ? state.recent : 0) + 1;

  // The last step is the ceiling; offences beyond it stay there rather than
  // growing without bound.
  const index = Math.min(offence - 1, MISSED_ACCEPT_COOLDOWNS_SECONDS.length - 1);
  const cooldownSeconds = MISSED_ACCEPT_COOLDOWNS_SECONDS[index]!;

  return {
    offence,
    cooldownSeconds,
    cooldownUntil: new Date(now.getTime() + cooldownSeconds * 1000),
  };
}

/** Seconds left on a cooldown, or 0 if there is none in force. */
export function cooldownRemainingSeconds(until: Date | null, now: Date = new Date()): number {
  if (!until) return 0;
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 1000));
}
