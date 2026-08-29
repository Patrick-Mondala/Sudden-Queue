import { beforeEach, describe, expect, it, vi } from "vitest";

import { Notifier, type ServerEvent } from "./notifier.js";
import { Population, type Counts } from "./population.js";

let notifier: Notifier;
let sent: { userId: string; event: ServerEvent }[];
let counts: Counts;
let reads: number;

/** A socket that records what it was told, per user. */
function connect(userId: string) {
  const conn = {
    send: (payload: string) => sent.push({ userId, event: JSON.parse(payload) as ServerEvent }),
    close: () => {},
  };
  notifier.add(userId, conn);
  return conn;
}

const counterEvents = () => sent.filter((s) => s.event.type === "queue.counts");

function build(overrides = {}) {
  return new Population(
    notifier,
    async () => {
      reads += 1;
      return counts;
    },
    { coalesceMs: 1, sweepMs: 10, ...overrides },
  );
}

beforeEach(() => {
  notifier = new Notifier();
  sent = [];
  reads = 0;
  counts = { online: 1, inQueue: 0, inMatch: 0 };
});

/** The coalesce window is 1ms here; this outlasts it. */
const settle = () => new Promise((r) => setTimeout(r, 15));

describe("nudging", () => {
  it("tells everyone the new numbers", async () => {
    connect("a");
    connect("b");
    const pop = build();

    pop.nudge();
    await settle();

    expect(counterEvents()).toHaveLength(2);
    expect(counterEvents()[0]!.event).toEqual({
      type: "queue.counts",
      online: 1,
      inQueue: 0,
      inMatch: 0,
    });
  });

  it("gathers a burst into one broadcast", async () => {
    connect("a");
    const pop = build();

    // Ten people connecting at once must not be ten reads and ten sends.
    for (let i = 0; i < 10; i += 1) pop.nudge();
    await settle();

    expect(reads).toBe(1);
    expect(counterEvents()).toHaveLength(1);
  });

  it("says nothing when the numbers have not moved", async () => {
    connect("a");
    const pop = build();

    pop.nudge();
    await settle();
    sent = [];

    pop.nudge();
    await settle();

    // It still looked -- it cannot know without looking -- but an unchanged
    // number is not news, and this is the case that runs all day.
    expect(reads).toBe(2);
    expect(counterEvents()).toHaveLength(0);
  });

  it("goes round again when something changes mid-read", async () => {
    connect("a");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;

    const pop = new Population(
      notifier,
      async () => {
        if (first) {
          first = false;
          await gate;
          return { online: 1, inQueue: 0, inMatch: 0 };
        }
        return { online: 1, inQueue: 5, inMatch: 0 };
      },
      { coalesceMs: 1, sweepMs: 10_000 },
    );

    pop.nudge();
    await new Promise((r) => setTimeout(r, 5)); // the read is now in flight
    pop.nudge(); // someone queued while it was reading
    // The nudge has to land while the read is still out, which is the only way
    // to reach the path under test -- release too early and the ordinary
    // coalesce timer covers for it and the test passes on a broken build.
    await new Promise((r) => setTimeout(r, 20));
    release();
    await settle();

    // The in-flight read was already stale when the second nudge arrived, so
    // dropping it would leave the wrong number up.
    const last = counterEvents().at(-1)!.event;
    expect(last).toMatchObject({ inQueue: 5 });
  });
});

describe("a socket that has just arrived", () => {
  it("is told where things stand without a read", async () => {
    connect("a");
    const pop = build();
    pop.nudge();
    await settle();
    sent = [];
    const before = reads;

    connect("b");
    pop.greet("b");

    expect(reads).toBe(before);
    expect(counterEvents()).toHaveLength(1);
    expect(counterEvents()[0]!.userId).toBe("b");
  });

  it("is not left on placeholders when its arrival moved nothing", async () => {
    connect("a");
    const pop = build();
    pop.nudge();
    await settle();
    sent = [];

    // A second window for someone already online: onlineCount is unchanged, so
    // the broadcast their connection triggers would never be sent.
    connect("a");
    pop.greet("a");
    pop.nudge();
    await settle();

    expect(counterEvents().length).toBeGreaterThan(0);
  });

  it("counts itself, rather than reporting the room it just walked into", async () => {
    connect("a");
    const pop = build();
    pop.nudge();
    await settle();
    sent = [];

    // The stored figure predates this connection. Sending it verbatim shows an
    // arrival "1 online" -- or on an empty server, "0" -- and corrects it a
    // quarter second later.
    connect("b");
    pop.greet("b");

    expect(counterEvents()[0]!.event).toMatchObject({ online: 2 });
  });

  it("stays quiet before there is anything to say", () => {
    connect("a");
    build().greet("a");

    expect(counterEvents()).toHaveLength(0);
  });
});

describe("the sweep", () => {
  it("corrects a number that changed with nobody nudging", async () => {
    connect("a");
    const pop = build();
    pop.nudge();
    await settle();
    sent = [];

    // Stands in for a caller that forgot to nudge.
    counts = { online: 1, inQueue: 7, inMatch: 0 };
    pop.start();
    await new Promise((r) => setTimeout(r, 40));
    pop.stop();

    expect(counterEvents().at(-1)!.event).toMatchObject({ inQueue: 7 });
  });

  it("stops when told to", async () => {
    connect("a");
    const pop = build();
    pop.start();
    pop.stop();
    const before = reads;

    await new Promise((r) => setTimeout(r, 40));
    expect(reads).toBe(before);
  });
});

describe("when the read fails", () => {
  it("leaves the last known numbers up rather than sending zeroes", async () => {
    connect("a");
    const onError = vi.fn();
    let fail = false;
    const pop = new Population(
      notifier,
      async () => {
        if (fail) throw new Error("database is down");
        return { online: 4, inQueue: 2, inMatch: 0 };
      },
      { coalesceMs: 1, sweepMs: 10_000, onError },
    );

    pop.nudge();
    await settle();
    sent = [];

    fail = true;
    pop.nudge();
    await settle();

    expect(onError).toHaveBeenCalled();
    expect(counterEvents()).toHaveLength(0);
    expect(pop.snapshot()).toEqual({ online: 4, inQueue: 2, inMatch: 0 });
  });
});
