import { describe, expect, it } from "vitest";

import {
  MISSED_ACCEPT_COOLDOWNS_SECONDS,
  MISSED_ACCEPT_DECAY_SECONDS,
} from "./constants.js";
import { cooldownRemainingSeconds, missedAcceptPenalty } from "./penalties.js";

const NOW = new Date("2026-01-01T12:00:00Z");
const agoSeconds = (s: number) => new Date(NOW.getTime() - s * 1000);

describe("missed accept penalties", () => {
  it("starts at the first step", () => {
    const p = missedAcceptPenalty({ recent: 0, lastAt: null }, NOW);
    expect(p.offence).toBe(1);
    expect(p.cooldownSeconds).toBe(MISSED_ACCEPT_COOLDOWNS_SECONDS[0]);
  });

  it("escalates through the schedule within a session", () => {
    const seen = [];
    for (let recent = 0; recent < MISSED_ACCEPT_COOLDOWNS_SECONDS.length; recent += 1) {
      seen.push(missedAcceptPenalty({ recent, lastAt: agoSeconds(60) }, NOW).cooldownSeconds);
    }
    expect(seen).toEqual([...MISSED_ACCEPT_COOLDOWNS_SECONDS]);
  });

  it("holds at the last step rather than growing without bound", () => {
    const p = missedAcceptPenalty({ recent: 99, lastAt: agoSeconds(60) }, NOW);
    expect(p.cooldownSeconds).toBe(MISSED_ACCEPT_COOLDOWNS_SECONDS.at(-1));
  });

  it("forgives a player who has been clean since", () => {
    // A bad night months ago should not follow someone around.
    const p = missedAcceptPenalty(
      { recent: 4, lastAt: agoSeconds(MISSED_ACCEPT_DECAY_SECONDS + 1) },
      NOW,
    );
    expect(p.offence).toBe(1);
    expect(p.cooldownSeconds).toBe(MISSED_ACCEPT_COOLDOWNS_SECONDS[0]);
  });

  it("keeps escalating right up to the decay boundary", () => {
    const p = missedAcceptPenalty(
      { recent: 1, lastAt: agoSeconds(MISSED_ACCEPT_DECAY_SECONDS - 60) },
      NOW,
    );
    expect(p.offence).toBe(2);
  });

  it("dates the cooldown from now", () => {
    const p = missedAcceptPenalty({ recent: 0, lastAt: null }, NOW);
    expect(p.cooldownUntil.getTime()).toBe(NOW.getTime() + p.cooldownSeconds * 1000);
  });
});

describe("cooldown remaining", () => {
  it("is zero when there is none", () => {
    expect(cooldownRemainingSeconds(null, NOW)).toBe(0);
  });

  it("is zero once it has passed, never negative", () => {
    expect(cooldownRemainingSeconds(agoSeconds(30), NOW)).toBe(0);
  });

  it("rounds up, so the last part-second still reads as time left", () => {
    expect(cooldownRemainingSeconds(new Date(NOW.getTime() + 1500), NOW)).toBe(2);
  });
});
