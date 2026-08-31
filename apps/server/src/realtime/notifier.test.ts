import { beforeEach, describe, expect, it } from "vitest";

import { Notifier, type ServerEvent } from "./notifier.js";

/**
 * One player, more than one client.
 *
 * The desktop app and a browser tab are two sessions of the same account, and
 * so are two tabs. Everything the app treats as belonging to the player rather
 * than to a window -- the queue above all -- is only consistent between them
 * because a user's connections are a set and every one of them is written to.
 *
 * Which client caused the event is deliberately not knowable here. That is what
 * makes it symmetric: queueing from the browser and queueing from the desktop
 * are the same code path, so neither can work while the other does not.
 */

let notifier: Notifier;

/** A socket that records what it was told. */
function connect(userId: string) {
  const seen: ServerEvent[] = [];
  const conn = {
    send: (payload: string) => seen.push(JSON.parse(payload) as ServerEvent),
    close: () => {},
  };
  notifier.add(userId, conn);
  return { conn, seen };
}

beforeEach(() => {
  notifier = new Notifier();
});

describe("one player signed in twice", () => {
  it("tells both sessions, whichever one acted", () => {
    const desktop = connect("u1");
    const browser = connect("u1");

    notifier.toUser("u1", { type: "queue.joined", partyId: "p1", regions: ["na"], joinedAt: 1 });

    expect(desktop.seen).toHaveLength(1);
    expect(browser.seen).toHaveLength(1);
    expect(desktop.seen[0]).toEqual(browser.seen[0]);
  });

  it("reaches every session of every party member", () => {
    const leaderDesktop = connect("leader");
    const leaderBrowser = connect("leader");
    // Only a leader may queue, so a member never makes the call that would
    // have told them. This is the only way they hear about it.
    const member = connect("member");
    const stranger = connect("stranger");

    notifier.toUsers(["leader", "member"], {
      type: "queue.joined",
      partyId: "p1",
      regions: ["na"],
      joinedAt: 1,
    });

    expect(leaderDesktop.seen).toHaveLength(1);
    expect(leaderBrowser.seen).toHaveLength(1);
    expect(member.seen).toHaveLength(1);
    expect(stranger.seen).toHaveLength(0);
  });

  it("keeps the other session when one closes", () => {
    const desktop = connect("u1");
    const browser = connect("u1");

    // Closing the browser must not take the account offline: the desktop app
    // is still there, and it is still the same queue ticket.
    notifier.remove("u1", browser.conn);
    notifier.toUser("u1", { type: "queue.left", partyId: "p1" });

    expect(notifier.isOnline("u1")).toBe(true);
    expect(desktop.seen).toHaveLength(1);
    expect(browser.seen).toHaveLength(0);
  });

  it("counts one player once, however many windows they have", () => {
    connect("u1");
    connect("u1");
    connect("u2");

    expect(notifier.onlineCount()).toBe(2);
  });

  it("goes offline only when the last session is gone", () => {
    const a = connect("u1");
    const b = connect("u1");

    notifier.remove("u1", a.conn);
    expect(notifier.isOnline("u1")).toBe(true);

    notifier.remove("u1", b.conn);
    expect(notifier.isOnline("u1")).toBe(false);
  });
});
