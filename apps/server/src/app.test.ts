import { INVITE_RATE_LIMIT, isOk } from "@suddenqueue/core";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type App, buildApp } from "./app.js";
import { matchParticipants, matches, playerRatings, scrimRequests, users } from "./db/schema/index.js";
import { AuthService } from "./auth/service.js";
import { DiscordAuth } from "./auth/discord.js";
import type { Config } from "./config.js";
import { expectNoRatings, makeUser, setupTestDatabase, truncateAll } from "./test/helpers.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let app: App;

const CONFIG: Config = {
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: "postgresql://unused",
  SESSION_SECRET: "s".repeat(48),
  DISCORD_CLIENT_ID: "cid",
  DISCORD_CLIENT_SECRET: "csecret",
  DISCORD_REDIRECT_URI: "http://127.0.0.1:3000/auth/discord/callback",
};

beforeAll(async () => {
  handle = await setupTestDatabase();
  // autoStart off: tests drive the matchmaker explicitly so a background timer
  // cannot consume a queue mid-assertion.
  app = await buildApp({ db: handle.db, config: CONFIG, autoStart: false, partyDisconnectGraceMs: 60 });
  await app.server.ready();
}, 60_000);

afterAll(async () => {
  await app?.server.close();
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

afterEach(() => {
  for (const c of connections) app.notifier.remove(c.userId, c.conn);
  connections.length = 0;
});

/** Signs a user in directly, skipping the Discord round trip. */
async function login(discordId = `d${Date.now()}${Math.random()}`) {
  const auth = new AuthService(
    handle.db,
    new DiscordAuth({
      clientId: "cid",
      clientSecret: "cs",
      redirectUri: CONFIG.DISCORD_REDIRECT_URI,
      stateSecret: CONFIG.SESSION_SECRET,
    }),
    app.services.sessions,
  );

  const r = await auth.loginWithProfile({
    id: discordId,
    username: `user${discordId}`,
    globalName: null,
    avatarUrl: null,
  });
  if (!isOk(r)) throw new Error("login failed");

  return { userId: r.data.userId, token: r.data.token };
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Sockets left open for the whole file, closed after each test. */
const connections: { userId: string; conn: { send: () => void; close: () => void } }[] = [];

/**
 * Marks players as connected.
 *
 * Scrims will not be arranged by a team that is not present, and presence is a
 * socket fact rather than a stored one -- so a test that never opens one has a
 * roster of ghosts.
 */
function goOnline(...userIds: string[]) {
  for (const userId of userIds) {
    const conn = { send: () => {}, close: () => {} };
    app.notifier.add(userId, conn);
    connections.push({ userId, conn });
  }
}

function goOffline(userId: string) {
  for (const c of connections.filter((c) => c.userId === userId)) {
    app.notifier.remove(c.userId, c.conn);
  }
}

describe("health and auth gating", () => {
  it("serves health without a session", async () => {
    const res = await app.server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects protected routes without a token", async () => {
    const res = await app.server.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a garbage token", async () => {
    const res = await app.server.inject({
      method: "GET",
      url: "/me",
      headers: authed("nonsense"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid bearer token", async () => {
    const { token, userId } = await login();
    const res = await app.server.inject({ method: "GET", url: "/me", headers: authed(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe(userId);
  });

  it("stops accepting a token after logout", async () => {
    const { token } = await login();
    const out = await app.server.inject({
      method: "POST",
      url: "/auth/logout",
      headers: authed(token),
    });
    expect(out.statusCode).toBe(200);

    const after = await app.server.inject({ method: "GET", url: "/me", headers: authed(token) });
    expect(after.statusCode).toBe(401);
  });
});

describe("oauth entry point", () => {
  it("redirects to Discord and stashes PKCE material in httpOnly cookies", async () => {
    const res = await app.server.inject({ method: "GET", url: "/auth/discord/start" });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("discord.com/oauth2/authorize");

    const cookies = res.cookies.map((c) => c.name);
    expect(cookies).toContain("sq_pkce");
    expect(cookies).toContain("sq_state");
    // The verifier must never be readable by page scripts.
    for (const c of res.cookies) expect(c.httpOnly).toBe(true);
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const res = await app.server.inject({
      method: "GET",
      url: "/auth/discord/callback?code=abc&state=forged",
      cookies: { sq_state: "different", sq_pkce: "verifier" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BAD_STATE");
  });

  it("refuses a callback with no cookies at all", async () => {
    const res = await app.server.inject({
      method: "GET",
      url: "/auth/discord/callback?code=abc&state=abc",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("party", () => {
  it("gives a new account a solo party automatically", async () => {
    const { token, userId } = await login();
    const res = await app.server.inject({ method: "GET", url: "/party", headers: authed(token) });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members).toHaveLength(1);
    expect(body.leaderId).toBe(userId);
  });

  it("runs the full invite and accept flow", async () => {
    const a = await login();
    const b = await login();

    const invite = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });
    expect(invite.statusCode).toBe(200);

    const pending = await app.server.inject({
      method: "GET",
      url: "/party/invites",
      headers: authed(b.token),
    });
    expect(pending.json()).toHaveLength(1);

    const accept = await app.server.inject({
      method: "POST",
      url: `/party/invite/${invite.json().inviteId}/accept`,
      headers: authed(b.token),
    });
    expect(accept.statusCode).toBe(200);

    const view = await app.server.inject({ method: "GET", url: "/party", headers: authed(a.token) });
    expect(view.json().members).toHaveLength(2);
  });

  it("refuses to invite yourself", async () => {
    const a = await login();
    const res = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: a.userId },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("CANNOT_INVITE_SELF");
  });

  it("leaving puts the player back in a solo party", async () => {
    const a = await login();
    const b = await login();

    const invite = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });
    await app.server.inject({
      method: "POST",
      url: `/party/invite/${invite.json().inviteId}/accept`,
      headers: authed(b.token),
    });

    const left = await app.server.inject({
      method: "POST",
      url: "/party/leave",
      headers: authed(b.token),
    });
    expect(left.statusCode).toBe(200);

    const bParty = await app.server.inject({
      method: "GET",
      url: "/party",
      headers: authed(b.token),
    });
    // Never party-less, always a party of one.
    expect(bParty.json().members).toHaveLength(1);

    const aParty = await app.server.inject({
      method: "GET",
      url: "/party",
      headers: authed(a.token),
    });
    expect(aParty.json().members).toHaveLength(1);
  });

  it("only the leader may kick", async () => {
    const a = await login();
    const b = await login();

    const invite = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });
    await app.server.inject({
      method: "POST",
      url: `/party/invite/${invite.json().inviteId}/accept`,
      headers: authed(b.token),
    });

    const byMember = await app.server.inject({
      method: "POST",
      url: "/party/kick",
      headers: authed(b.token),
      payload: { userId: a.userId },
    });
    expect(byMember.statusCode).toBe(409);
    expect(byMember.json().error).toBe("NOT_LEADER");

    const byLeader = await app.server.inject({
      method: "POST",
      url: "/party/kick",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });
    expect(byLeader.statusCode).toBe(200);
  });
});

describe("queue", () => {
  it("joins and leaves", async () => {
    const a = await login();

    const join = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(a.token),
      payload: { regions: ["na"] },
    });
    expect(join.statusCode).toBe(200);
    expect(join.json().size).toBe(1);

    const stats = await app.server.inject({ method: "GET", url: "/queue/stats" });
    expect(stats.json().inQueue).toBe(1);

    const leave = await app.server.inject({
      method: "POST",
      url: "/queue/leave",
      headers: authed(a.token),
    });
    expect(leave.statusCode).toBe(200);
  });

  it("rejects an empty region list", async () => {
    const a = await login();
    const res = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(a.token),
      payload: { regions: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown region", async () => {
    const a = await login();
    const res = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(a.token),
      payload: { regions: ["mars"] },
    });

    expect(res.statusCode).toBe(400);
  });

  it("refuses a double join", async () => {
    const a = await login();
    const payload = { regions: ["na"] };

    await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(a.token),
      payload,
    });
    const second = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(a.token),
      payload,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("ALREADY_QUEUED");
  });

  it("refuses to leave when not queued", async () => {
    const a = await login();
    const res = await app.server.inject({
      method: "POST",
      url: "/queue/leave",
      headers: authed(a.token),
    });

    expect(res.statusCode).toBe(409);
  });
});

describe("end to end: ten solos become a match", () => {
  it("queues ten players, runs a pass, and produces an accept prompt", async () => {
    const players = [];
    for (let i = 0; i < 10; i += 1) players.push(await login());

    for (const p of players) {
      const res = await app.server.inject({
        method: "POST",
        url: "/queue/join",
        headers: authed(p.token),
        payload: { regions: ["na"] },
      });
      expect(res.statusCode).toBe(200);
    }

    const created = await app.matchmaker.runPass();
    expect(created).toBe(1);

    // Queue drained into the match.
    const stats = await app.server.inject({ method: "GET", url: "/queue/stats" });
    expect(stats.json().inQueue).toBe(0);

    // Every player can see the match, and it is awaiting accepts.
    const first = players[0]!;
    const partyId = await app.services.party.partyIdFor(first.userId);
    expect(partyId).not.toBeNull();

    const matches = await app.services.lifecycle.ratingsFor([first.userId]);
    expect(matches.size).toBe(1);
  });

  it("all ten accepting advances the match to party-up", async () => {
    const players = [];
    for (let i = 0; i < 10; i += 1) players.push(await login());
    for (const p of players) {
      await app.server.inject({
        method: "POST",
        url: "/queue/join",
        headers: authed(p.token),
        payload: { regions: ["na"] },
      });
    }
    await app.matchmaker.runPass();

    const matchId = await findMatchIdFor(players[0]!.userId);
    expect(matchId).not.toBeNull();

    for (const p of players) {
      const res = await app.server.inject({
        method: "POST",
        url: `/match/${matchId}/accept`,
        headers: authed(p.token),
      });
      expect(res.statusCode).toBe(200);
    }

    const match = await app.services.lifecycle.getMatch(matchId!);
    expect(match!.state).toBe("PARTY_UP");
  });

  it("one decline cancels the match for everyone", async () => {
    const players = [];
    for (let i = 0; i < 10; i += 1) players.push(await login());
    for (const p of players) {
      await app.server.inject({
        method: "POST",
        url: "/queue/join",
        headers: authed(p.token),
        payload: { regions: ["na"] },
      });
    }
    await app.matchmaker.runPass();

    const matchId = await findMatchIdFor(players[0]!.userId);
    const res = await app.server.inject({
      method: "POST",
      url: `/match/${matchId}/decline`,
      headers: authed(players[3]!.token),
    });

    expect(res.statusCode).toBe(200);
    const match = await app.services.lifecycle.getMatch(matchId!);
    expect(match!.state).toBe("CANCELLED");
    expect(match!.cancelReason).toBe("DECLINED");
  });

  it("a non-participant cannot view someone else's match", async () => {
    const players = [];
    for (let i = 0; i < 10; i += 1) players.push(await login());
    for (const p of players) {
      await app.server.inject({
        method: "POST",
        url: "/queue/join",
        headers: authed(p.token),
        payload: { regions: ["na"] },
      });
    }
    await app.matchmaker.runPass();

    const matchId = await findMatchIdFor(players[0]!.userId);
    const outsider = await login();

    const res = await app.server.inject({
      method: "GET",
      url: `/match/${matchId}`,
      headers: authed(outsider.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("reporting through the API", () => {
  /** Queues ten players, matches them, accepts, and forces the match live. */
  async function liveMatch() {
    const players = [];
    for (let i = 0; i < 10; i += 1) players.push(await login());
    for (const p of players) {
      await app.server.inject({
        method: "POST",
        url: "/queue/join",
        headers: authed(p.token),
        payload: { regions: ["na"] },
      });
    }
    await app.matchmaker.runPass();

    const matchId = (await findMatchIdFor(players[0]!.userId))!;
    for (const p of players) {
      await app.server.inject({
        method: "POST",
        url: `/match/${matchId}/accept`,
        headers: authed(p.token),
      });
    }

    await handle.db.update(matches).set({ state: "LIVE" }).where(eq(matches.id, matchId));

    const parts = await app.services.lifecycle.participants(matchId);
    const capA = parts.find((p) => p.team === 1 && p.isCaptain)!.userId;
    const capB = parts.find((p) => p.team === 2 && p.isCaptain)!.userId;

    return {
      matchId,
      players,
      captain1: players.find((p) => p.userId === capA)!,
      captain2: players.find((p) => p.userId === capB)!,
      nonCaptain: players.find((p) => p.userId !== capA && p.userId !== capB)!,
    };
  }

  it("refuses a report from a non-captain", async () => {
    const m = await liveMatch();
    const res = await app.server.inject({
      method: "POST",
      url: `/match/${m.matchId}/report`,
      headers: authed(m.nonCaptain.token),
      payload: { winner: "TEAM1" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("NOT_A_CAPTAIN");
  });

  it("rejects a winner value that is not a team", async () => {
    const m = await liveMatch();
    const res = await app.server.inject({
      method: "POST",
      url: `/match/${m.matchId}/report`,
      headers: authed(m.captain1.token),
      payload: { winner: "NOBODY" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("holds at REPORTED until the second captain agrees, then settles", async () => {
    const m = await liveMatch();

    const first = await app.server.inject({
      method: "POST",
      url: `/match/${m.matchId}/report`,
      headers: authed(m.captain1.token),
      payload: { winner: "TEAM1" },
    });
    expect(first.json().state).toBe("REPORTED");

    const second = await app.server.inject({
      method: "POST",
      url: `/match/${m.matchId}/report`,
      headers: authed(m.captain2.token),
      payload: { winner: "TEAM1" },
    });
    expect(second.json().state).toBe("COMPLETED");
    expect(second.json().winner).toBe("TEAM1");
  });

  it("shows the settled match in the player's history, without the delta", async () => {
    const m = await liveMatch();
    await app.server.inject({
      method: "POST",
      url: `/match/${m.matchId}/report`,
      headers: authed(m.captain1.token),
      payload: { winner: "TEAM1" },
    });
    await app.server.inject({
      method: "POST",
      url: `/match/${m.matchId}/report`,
      headers: authed(m.captain2.token),
      payload: { winner: "TEAM1" },
    });

    const history = await app.server.inject({
      method: "GET",
      url: "/me/history",
      headers: authed(m.captain1.token),
    });

    const rows = history.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe("TEAM1");
    // Rank is the published unit; a run of deltas would rebuild the rating.
    expect(rows[0]).not.toHaveProperty("ratingDelta");
  });

  it("still serves a settled match, so history rows can open their rosters", async () => {
    const m = await liveMatch();
    for (const cap of [m.captain1, m.captain2]) {
      await app.server.inject({
        method: "POST",
        url: `/match/${m.matchId}/report`,
        headers: authed(cap.token),
        payload: { winner: "TEAM1" },
      });
    }

    // The history list carries no rosters, so opening a past match depends on
    // this route not closing once the match is over.
    const res = await app.server.inject({
      method: "GET",
      url: `/match/${m.matchId}`,
      headers: authed(m.captain1.token),
    });

    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.state).toBe("COMPLETED");
    expect(view.team1).toHaveLength(5);
    expect(view.team2).toHaveLength(5);
  });

  it("disagreement opens a dispute", async () => {
    const m = await liveMatch();
    await app.server.inject({
      method: "POST",
      url: `/match/${m.matchId}/report`,
      headers: authed(m.captain1.token),
      payload: { winner: "TEAM1" },
    });
    const clash = await app.server.inject({
      method: "POST",
      url: `/match/${m.matchId}/report`,
      headers: authed(m.captain2.token),
      payload: { winner: "TEAM2" },
    });

    expect(clash.json().state).toBe("DISPUTED");
  });

  it("keeps the dispute queue behind a game master check", async () => {
    const player = await login();
    const denied = await app.server.inject({
      method: "GET",
      url: "/mod/disputes",
      headers: authed(player.token),
    });
    expect(denied.statusCode).toBe(403);

    await handle.db
      .update(users)
      .set({ role: "game_master" })
      .where(eq(users.id, player.userId));

    const allowed = await app.server.inject({
      method: "GET",
      url: "/mod/disputes",
      headers: authed(player.token),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("lets a game master rule on a dispute and settle it", async () => {
    const m = await liveMatch();
    await app.server.inject({
      method: "POST",
      url: `/match/${m.matchId}/report`,
      headers: authed(m.captain1.token),
      payload: { winner: "TEAM1" },
    });
    await app.server.inject({
      method: "POST",
      url: `/match/${m.matchId}/report`,
      headers: authed(m.captain2.token),
      payload: { winner: "TEAM2" },
    });

    const mod = await login();
    await handle.db.update(users).set({ role: "game_master" }).where(eq(users.id, mod.userId));

    const ruling = await app.server.inject({
      method: "POST",
      url: `/mod/disputes/${m.matchId}/resolve`,
      headers: authed(mod.token),
      payload: { winner: "TEAM1", note: "Reviewed screenshots" },
    });

    expect(ruling.statusCode).toBe(200);
    expect(ruling.json().state).toBe("COMPLETED");

    const match = await app.services.lifecycle.getMatch(m.matchId);
    expect(match!.result).toBe("TEAM1");
  });

  it("requires a note on a ruling", async () => {
    const mod = await login();
    await handle.db.update(users).set({ role: "game_master" }).where(eq(users.id, mod.userId));

    const res = await app.server.inject({
      method: "POST",
      url: "/mod/disputes/00000000-0000-0000-0000-000000000000/resolve",
      headers: authed(mod.token),
      payload: { winner: "TEAM1" },
    });

    expect(res.statusCode).toBe(400);
  });
});

/** Finds the match a user currently belongs to, via the participants table. */
async function findMatchIdFor(userId: string): Promise<string | null> {
  const rows = await handle.db.query.matchParticipants.findMany({
    where: (mp, { eq }) => eq(mp.userId, userId),
    limit: 1,
  });
  return rows[0]?.matchId ?? null;
}

describe("who you can invite", () => {
  /** Marks a user online, which is a socket fact rather than a stored one. */
  function goOnline(userId: string) {
    const conn = { send: () => {}, close: () => {} };
    app.notifier.add(userId, conn);
    return () => app.notifier.remove(userId, conn);
  }

  it("lists everyone else connected, and never yourself", async () => {
    const a = await login();
    const b = await login();
    const offline = await login();

    const stopA = goOnline(a.userId);
    const stopB = goOnline(b.userId);

    const res = await app.server.inject({
      method: "GET",
      url: "/players/online",
      headers: authed(a.token),
    });

    expect(res.statusCode).toBe(200);
    const ids = res.json().players.map((p: { id: string }) => p.id);
    expect(ids).toContain(b.userId);
    expect(ids).not.toContain(a.userId);
    expect(ids).not.toContain(offline.userId);

    stopA();
    stopB();
  });

  it("publishes rank, never rating", async () => {
    const a = await login();
    const b = await login();
    const stopA = goOnline(a.userId);
    const stopB = goOnline(b.userId);

    const res = await app.server.inject({
      method: "GET",
      url: "/players/online",
      headers: authed(a.token),
    });

    const [player] = res.json().players;
    expect(player).not.toHaveProperty("rating");
    expect(player).toHaveProperty("tier");
    expect(player).toHaveProperty("placementsRemaining");

    stopA();
    stopB();
  });

  it("still lists someone already in a party, and says why they are out", async () => {
    const a = await login();
    const b = await login();
    const c = await login();

    // b and c group up, so b is listed but not invitable.
    const invite = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(b.token),
      payload: { userId: c.userId },
    });
    await app.server.inject({
      method: "POST",
      url: `/party/invite/${invite.json().inviteId}/accept`,
      headers: authed(c.token),
    });

    const stops = [a, b, c].map((u) => goOnline(u.userId));

    const res = await app.server.inject({
      method: "GET",
      url: "/players/online",
      headers: authed(a.token),
    });

    const found = res.json().players.find((p: { id: string }) => p.id === b.userId);
    expect(found).toBeTruthy();
    expect(found.unavailable).toBe("In a party");

    for (const stop of stops) stop();
  });
});

describe("invite throttling", () => {
  it("refuses a second invite to the same player straight away", async () => {
    const a = await login();
    const b = await login();

    const first = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });

    // A "not yet" rather than a "no", so the client can count down to it.
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe("RECENTLY_INVITED");
    expect(second.json().message).toMatch(/\d+s/);
  });

  it("declining does not reopen the cooldown", async () => {
    const a = await login();
    const b = await login();

    const first = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });

    await app.server.inject({
      method: "POST",
      url: `/party/invite/${first.json().inviteId}/decline`,
      headers: authed(b.token),
    });

    // Otherwise the quickest route to spamming someone is to have them decline.
    const again = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });
    expect(again.statusCode).toBe(429);
  });

  it("caps how fast one player can work through the list", async () => {
    const a = await login();
    const targets = [];
    for (let i = 0; i < INVITE_RATE_LIMIT + 1; i += 1) targets.push(await login());

    const codes = [];
    for (const t of targets) {
      const res = await app.server.inject({
        method: "POST",
        url: "/party/invite",
        headers: authed(a.token),
        payload: { userId: t.userId },
      });
      codes.push(res.statusCode);
    }

    expect(codes.filter((c) => c === 200)).toHaveLength(INVITE_RATE_LIMIT);
    expect(codes.at(-1)).toBe(429);
  });

  it("is per inviter, so one spammer cannot block everyone else", async () => {
    const spammer = await login();
    const innocent = await login();
    const targets = [];
    for (let i = 0; i < INVITE_RATE_LIMIT; i += 1) targets.push(await login());

    for (const t of targets) {
      await app.server.inject({
        method: "POST",
        url: "/party/invite",
        headers: authed(spammer.token),
        payload: { userId: t.userId },
      });
    }

    const res = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(innocent.token),
      payload: { userId: targets[0]!.userId },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("party rules that only bite in a race", () => {
  async function queueUp(token: string) {
    return app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(token),
      payload: { regions: ["na"] },
    });
  }

  it("will not invite someone who is in the queue", async () => {
    const a = await login();
    const b = await login();
    expect((await queueUp(b.token)).statusCode).toBe(200);

    // Accepting would delete their solo party and take its ticket with it, so
    // they would lose their place in line without being asked.
    const res = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("TARGET_QUEUED");
  });

  it("refuses an invite from someone who no longer leads the party", async () => {
    const a = await login();
    const b = await login();
    const c = await login();

    // a builds a party with c, then invites b, then walks out. Leadership
    // passes to c, who never invited anyone.
    const toC = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: c.userId },
    });
    await app.server.inject({
      method: "POST",
      url: `/party/invite/${toC.json().inviteId}/accept`,
      headers: authed(c.token),
    });

    const toB = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });
    expect(toB.statusCode).toBe(200);

    await app.server.inject({ method: "POST", url: "/party/leave", headers: authed(a.token) });

    const accept = await app.server.inject({
      method: "POST",
      url: `/party/invite/${toB.json().inviteId}/accept`,
      headers: authed(b.token),
    });

    expect(accept.statusCode).toBe(409);
    expect(accept.json().error).toBe("INVITER_NOT_LEADER");
  });

  it("tells the party you walked out of that you have gone", async () => {
    const a = await login();
    const b = await login();
    const c = await login();

    // b and c are a pair; then a poaches c.
    const pair = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(b.token),
      payload: { userId: c.userId },
    });
    await app.server.inject({
      method: "POST",
      url: `/party/invite/${pair.json().inviteId}/accept`,
      headers: authed(c.token),
    });

    const poach = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: c.userId },
    });
    // c is in a party of two, so this is refused outright -- the same rule the
    // earlier system enforced. c has to leave first.
    expect(poach.statusCode).toBe(409);
    expect(poach.json().error).toBe("TARGET_IN_PARTY");

    await app.server.inject({ method: "POST", url: "/party/leave", headers: authed(c.token) });

    const view = await app.server.inject({ method: "GET", url: "/party", headers: authed(b.token) });
    expect(view.json().members).toHaveLength(1);
    expect(view.json().leaderId).toBe(b.userId);
  });

  it("hands leadership on when the leader leaves", async () => {
    const a = await login();
    const b = await login();

    const inv = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });
    await app.server.inject({
      method: "POST",
      url: `/party/invite/${inv.json().inviteId}/accept`,
      headers: authed(b.token),
    });

    await app.server.inject({ method: "POST", url: "/party/leave", headers: authed(a.token) });

    const view = await app.server.inject({ method: "GET", url: "/party", headers: authed(b.token) });
    expect(view.json().leaderId).toBe(b.userId);
    expect(view.json().members).toHaveLength(1);
  });
});

describe("someone closing the app", () => {
  function connect(userId: string) {
    const conn = { send: () => {}, close: () => {} };
    app.notifier.add(userId, conn);
    return () => app.notifier.remove(userId, conn);
  }

  /** The grace is 60ms in tests; give it room without being flaky. */
  const afterGrace = () => new Promise((r) => setTimeout(r, 400));

  async function pairUp(a: { token: string }, b: { token: string; userId: string }) {
    const inv = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(a.token),
      payload: { userId: b.userId },
    });
    await app.server.inject({
      method: "POST",
      url: `/party/invite/${inv.json().inviteId}/accept`,
      headers: authed(b.token),
    });
  }

  it("takes them out of the party once they are really gone", async () => {
    const a = await login();
    const b = await login();
    const stopA = connect(a.userId);
    const stopB = connect(b.userId);
    await pairUp(a, b);

    stopB();
    await afterGrace();

    // Otherwise a closed app holds a slot in a five-stack and the leader has to
    // notice and kick a ghost.
    const view = await app.server.inject({ method: "GET", url: "/party", headers: authed(a.token) });
    expect(view.json().members).toHaveLength(1);
    expect(view.json().members[0].userId).toBe(a.userId);

    stopA();
  });

  it("leaves the party alone if they come straight back", async () => {
    const a = await login();
    const b = await login();
    const stopA = connect(a.userId);
    let stopB = connect(b.userId);
    await pairUp(a, b);

    // A dropped socket is usually a blip, and the client reconnects on its own.
    stopB();
    stopB = connect(b.userId);
    await afterGrace();

    const view = await app.server.inject({ method: "GET", url: "/party", headers: authed(a.token) });
    expect(view.json().members).toHaveLength(2);

    stopA();
    stopB();
  });

  it("leaves a solo party be, since it is theirs to come back to", async () => {
    const a = await login();
    const stop = connect(a.userId);
    const before = await app.server.inject({ method: "GET", url: "/party", headers: authed(a.token) });

    stop();
    await afterGrace();

    const after = await app.server.inject({ method: "GET", url: "/party", headers: authed(a.token) });
    expect(after.json().partyId).toBe(before.json().partyId);
  });
});

describe("missing a match you were matched into", () => {
  /**
   * Ten queued solos, matched, so the accept window can be blown.
   *
   * `include` puts an existing player in the match rather than a fresh one,
   * which is what a second offence needs: the same person, twice.
   */
  async function matchTen(include?: { token: string; userId: string }) {
    const players = include ? [include] : [];
    if (include) {
      await app.server.inject({
        method: "POST",
        url: "/queue/join",
        headers: authed(include.token),
        payload: { regions: ["na"] },
      });
    }

    while (players.length < 10) {
      const u = await login();
      await app.server.inject({
        method: "POST",
        url: "/queue/join",
        headers: authed(u.token),
        payload: { regions: ["na"] },
      });
      players.push(u);
    }

    await app.matchmaker.runPass();
    const [match] = await handle.db
      .select()
      .from(matches)
      .orderBy(desc(matches.createdAt))
      .limit(1);
    if (!match) throw new Error("no match formed");
    return { players, matchId: match.id };
  }

  /** Blows the accept window without waiting it out. */
  async function expireAccepts(matchId: string) {
    await handle.db
      .update(matches)
      .set({ acceptDeadline: new Date(Date.now() - 1000) })
      .where(eq(matches.id, matchId));
    await app.sweeper.sweepOnce();
  }

  it("puts the people who missed it on a cooldown, and nobody else", async () => {
    const { players, matchId } = await matchTen();

    // Nine accept; one sits on the prompt.
    for (const p of players.slice(0, 9)) {
      await app.server.inject({
        method: "POST",
        url: `/match/${matchId}/accept`,
        headers: authed(p.token),
      });
    }
    await expireAccepts(matchId);

    const dodger = players[9]!;
    const blocked = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(dodger.token),
      payload: { regions: ["na"] },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("QUEUE_COOLDOWN");
    expect(blocked.json().secondsRemaining).toBeGreaterThan(0);

    // The nine who did accept are not punished for someone else's no-show.
    const innocent = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(players[0]!.token),
      payload: { regions: ["na"] },
    });
    expect(innocent.statusCode).toBe(200);
  });

  it("escalates a second miss beyond the first", async () => {
    const first = await matchTen();
    await expireAccepts(first.matchId);

    const dodger = first.players[0]!;
    const one = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(dodger.token),
      payload: { regions: ["na"] },
    });
    const firstWait = one.json().secondsRemaining;

    // Clear the cooldown so they can reach a second match, leaving the offence
    // count behind -- which is the thing being tested.
    await handle.db
      .update(playerRatings)
      .set({ queueCooldownUntil: null })
      .where(eq(playerRatings.userId, dodger.userId));

    const second = await matchTen(dodger);

    // Everyone but the dodger accepts, so only they are at fault this time.
    await handle.db
      .update(matchParticipants)
      .set({ acceptedAt: new Date() })
      .where(eq(matchParticipants.matchId, second.matchId));
    await handle.db
      .update(matchParticipants)
      .set({ acceptedAt: null })
      .where(
        and(
          eq(matchParticipants.matchId, second.matchId),
          eq(matchParticipants.userId, dodger.userId),
        ),
      );
    await expireAccepts(second.matchId);

    const two = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(dodger.token),
      payload: { regions: ["na"] },
    });
    expect(two.json().secondsRemaining).toBeGreaterThan(firstWait);
  });

  it("blocks the whole party when one member is cooling off", async () => {
    const { players, matchId } = await matchTen();
    await expireAccepts(matchId);

    const dodger = players[0]!;
    const friend = await login();

    // The friend leads, so the cooldown is not theirs; it still stops the party.
    const inv = await app.server.inject({
      method: "POST",
      url: "/party/invite",
      headers: authed(friend.token),
      payload: { userId: dodger.userId },
    });
    await app.server.inject({
      method: "POST",
      url: `/party/invite/${inv.json().inviteId}/accept`,
      headers: authed(dodger.token),
    });

    const res = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(friend.token),
      payload: { regions: ["na"] },
    });

    // Otherwise a cooldown is just "ask a friend to carry you past it".
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("QUEUE_COOLDOWN");
    expect(res.json().message).toMatch(/cooldown/i);
  });

  it("declining costs the same as sitting on it", async () => {
    const { players, matchId } = await matchTen();

    await app.server.inject({
      method: "POST",
      url: `/match/${matchId}/decline`,
      headers: authed(players[0]!.token),
    });

    const res = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(players[0]!.token),
      payload: { regions: ["na"] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("QUEUE_COOLDOWN");
  });

  it("stops a banned account queueing, which it never did before", async () => {
    const a = await login();
    await handle.db
      .update(users)
      .set({ bannedUntil: new Date(Date.now() + 60_000) })
      .where(eq(users.id, a.userId));

    const res = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(a.token),
      payload: { regions: ["na"] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("BANNED");
  });

  it("reports the remaining cooldown on the profile", async () => {
    const { players, matchId } = await matchTen();
    await expireAccepts(matchId);

    const me = await app.server.inject({
      method: "GET",
      url: "/me",
      headers: authed(players[0]!.token),
    });

    expect(me.json().queueCooldownSeconds).toBeGreaterThan(0);
    expect(me.json().missedAccepts).toBe(1);
  });
});

describe("teams over the API", () => {
  async function register(token: string, tag = "ACE", region = "na") {
    return app.server.inject({
      method: "POST",
      url: "/teams",
      headers: authed(token),
      payload: { tag, name: `${tag} Team`, region },
    });
  }

  async function applyAndAccept(applicant: { token: string }, teamId: string, manager: { token: string }) {
    const applied = await app.server.inject({
      method: "POST",
      url: `/teams/${teamId}/apply`,
      headers: authed(applicant.token),
      payload: { note: null },
    });
    const decided = await app.server.inject({
      method: "POST",
      url: `/team/applications/${applied.json().applicationId}/decide`,
      headers: authed(manager.token),
      payload: { accept: true },
    });
    return { applied, decided };
  }

  it("runs registering, applying and accepting through the routes", async () => {
    const captain = await login();
    const rookie = await login();

    const created = await register(captain.token);
    expect(created.statusCode).toBe(200);
    const { teamId } = created.json();

    const { decided } = await applyAndAccept(rookie, teamId, captain);
    expect(decided.statusCode).toBe(200);

    const mine = await app.server.inject({
      method: "GET",
      url: "/me/team",
      headers: authed(rookie.token),
    });
    expect(mine.json().team.id).toBe(teamId);
    expect(mine.json().role).toBe("member");
  });

  it("shows applications to managers and hides them from the rest", async () => {
    const captain = await login();
    const member = await login();
    const applicant = await login();

    const { teamId } = (await register(captain.token)).json();
    await applyAndAccept(member, teamId, captain);

    await app.server.inject({
      method: "POST",
      url: `/teams/${teamId}/apply`,
      headers: authed(applicant.token),
      payload: {},
    });

    const asCaptain = await app.server.inject({
      method: "GET",
      url: "/me/team",
      headers: authed(captain.token),
    });
    expect(asCaptain.json().applications).toHaveLength(1);

    // A plain member has no business reviewing the queue of applicants.
    const asMember = await app.server.inject({
      method: "GET",
      url: "/me/team",
      headers: authed(member.token),
    });
    expect(asMember.json().applications).toHaveLength(0);
  });

  it("refuses roster management to someone outside the team", async () => {
    const captain = await login();
    const member = await login();
    const stranger = await login();

    const { teamId } = (await register(captain.token)).json();
    await applyAndAccept(member, teamId, captain);

    const kick = await app.server.inject({
      method: "DELETE",
      url: `/team/members/${member.userId}`,
      headers: authed(stranger.token),
    });
    expect(kick.statusCode).toBeGreaterThanOrEqual(400);

    const stillThere = await app.server.inject({
      method: "GET",
      url: `/teams/${teamId}`,
      headers: authed(stranger.token),
    });
    expect(stillThere.json().members).toHaveLength(2);
  });

  it("answers 403 when an officer tries to appoint officers", async () => {
    const captain = await login();
    const officer = await login();
    const member = await login();

    const { teamId } = (await register(captain.token)).json();
    await applyAndAccept(officer, teamId, captain);
    await applyAndAccept(member, teamId, captain);

    await app.server.inject({
      method: "POST",
      url: `/team/members/${officer.userId}/role`,
      headers: authed(captain.token),
      payload: { role: "officer" },
    });

    const res = await app.server.inject({
      method: "POST",
      url: `/team/members/${member.userId}/role`,
      headers: authed(officer.token),
      payload: { role: "officer" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("tells the roster when it changes", async () => {
    const captain = await login();
    const rookie = await login();
    const { teamId } = (await register(captain.token)).json();

    const seen: unknown[] = [];
    const conn = {
      send: (payload: string) => seen.push(JSON.parse(payload)),
      close: () => {},
    };
    app.notifier.add(captain.userId, conn);

    await applyAndAccept(rookie, teamId, captain);

    // Otherwise a captain has to refresh to see who they just accepted.
    const updates = seen.filter((e) => (e as { type: string }).type === "team.updated");
    expect(updates.length).toBeGreaterThan(0);
    const last = updates.at(-1) as { team: { members: unknown[] } };
    expect(last.team.members).toHaveLength(2);

    app.notifier.remove(captain.userId, conn);
  });

  it("lets the applicant hear a decision either way", async () => {
    const captain = await login();
    const applicant = await login();
    const { teamId } = (await register(captain.token)).json();

    const seen: { type: string; accepted?: boolean }[] = [];
    const conn = {
      send: (payload: string) => seen.push(JSON.parse(payload)),
      close: () => {},
    };
    app.notifier.add(applicant.userId, conn);

    const applied = await app.server.inject({
      method: "POST",
      url: `/teams/${teamId}/apply`,
      headers: authed(applicant.token),
      payload: {},
    });
    await app.server.inject({
      method: "POST",
      url: `/team/applications/${applied.json().applicationId}/decide`,
      headers: authed(captain.token),
      payload: { accept: false },
    });

    // A denial is otherwise silence, which reads as being ignored.
    const decided = seen.find((e) => e.type === "team.application.decided");
    expect(decided).toBeTruthy();
    expect(decided!.accepted).toBe(false);

    app.notifier.remove(applicant.userId, conn);
  });

  it("frees everyone when the team is disbanded", async () => {
    const captain = await login();
    const member = await login();
    const { teamId } = (await register(captain.token)).json();
    await applyAndAccept(member, teamId, captain);

    const res = await app.server.inject({
      method: "DELETE",
      url: "/team",
      headers: authed(captain.token),
    });
    expect(res.statusCode).toBe(200);

    for (const u of [captain, member]) {
      const mine = await app.server.inject({
        method: "GET",
        url: "/me/team",
        headers: authed(u.token),
      });
      expect(mine.json().team).toBeNull();
    }
  });

  it("lists teams and filters by region", async () => {
    const a = await login();
    const b = await login();
    await register(a.token, "NAA", "na");
    await register(b.token, "EUE", "eu");

    const all = await app.server.inject({ method: "GET", url: "/teams", headers: authed(a.token) });
    expect(all.json().teams).toHaveLength(2);

    const eu = await app.server.inject({
      method: "GET",
      url: "/teams?region=eu",
      headers: authed(a.token),
    });
    expect(eu.json().teams).toHaveLength(1);
    expect(eu.json().teams[0].tag).toBe("EUE");
  });

  it("never puts a rating in the directory", async () => {
    const captain = await login();
    await register(captain.token, "RNK");

    const res = await app.server.inject({
      method: "GET",
      url: "/teams",
      headers: authed(captain.token),
    });

    // Same rule as everywhere else: rank is published, the number is not.
    expectNoRatings(res.json());
  });
});

describe("scrims over the API", () => {
  /** A registered team with a full five, built through the routes. */
  async function squad(tag: string, size = 5) {
    const captain = await login();
    const created = await app.server.inject({
      method: "POST",
      url: "/teams",
      headers: authed(captain.token),
      payload: { tag, name: `${tag} Squad`, region: "na" },
    });
    const teamId = created.json().teamId as string;

    const members = [captain];
    for (let i = 1; i < size; i += 1) {
      const u = await login();
      const applied = await app.server.inject({
        method: "POST",
        url: `/teams/${teamId}/apply`,
        headers: authed(u.token),
        payload: {},
      });
      await app.server.inject({
        method: "POST",
        url: `/team/applications/${applied.json().applicationId}/decide`,
        headers: authed(captain.token),
        payload: { accept: true },
      });
      members.push(u);
    }

    goOnline(...members.map((m) => m.userId));
    return { teamId, captain, members };
  }

  async function list(captainToken: string, note: string | null = null) {
    return app.server.inject({
      method: "POST",
      url: "/scrims",
      headers: authed(captainToken),
      payload: { region: "na", note },
    });
  }

  it("runs list, request and accept through to a match", async () => {
    const host = await squad("HST");
    const guest = await squad("GST");

    const listed = await list(host.captain.token, "Bo1 tonight");
    expect(listed.statusCode).toBe(200);

    const board = await app.server.inject({
      method: "GET",
      url: "/scrims",
      headers: authed(guest.captain.token),
    });
    expect(board.json().listings).toHaveLength(1);
    expect(board.json().listings[0].note).toBe("Bo1 tonight");

    const requested = await app.server.inject({
      method: "POST",
      url: `/scrims/${listed.json().listingId}/request`,
      headers: authed(guest.captain.token),
    });
    expect(requested.statusCode).toBe(200);

    const incoming = await app.server.inject({
      method: "GET",
      url: "/scrims",
      headers: authed(host.captain.token),
    });
    expect(incoming.json().incoming).toHaveLength(1);

    const accepted = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requested.json().requestId}/decide`,
      headers: authed(host.captain.token),
      payload: { accept: true },
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().accepted).toBe(true);

    // The same prompt a PUG raises, for all ten.
    const match = await app.server.inject({
      method: "GET",
      url: `/match/${accepted.json().matchId}`,
      headers: authed(host.captain.token),
    });
    expect(match.json().type).toBe("SCRIM");
    expect(match.json().state).toBe("PENDING_ACCEPT");
    expect(match.json().team1).toHaveLength(5);
    expect(match.json().team2).toHaveLength(5);
  });

  it("tells all ten about the match, not just the captains", async () => {
    const host = await squad("HST");
    const guest = await squad("GST");

    const seen: { type: string }[] = [];
    const conn = { send: (p: string) => seen.push(JSON.parse(p)), close: () => {} };
    // A plain member of the guest team, who agreed to nothing themselves.
    app.notifier.add(guest.members[3]!.userId, conn);

    const listed = await list(host.captain.token);
    const requested = await app.server.inject({
      method: "POST",
      url: `/scrims/${listed.json().listingId}/request`,
      headers: authed(guest.captain.token),
    });
    await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requested.json().requestId}/decide`,
      headers: authed(host.captain.token),
      payload: { accept: true },
    });

    expect(seen.some((e) => e.type === "match.found")).toBe(true);
    app.notifier.remove(guest.members[3]!.userId, conn);
  });

  it("takes the listing down once it is matched", async () => {
    const host = await squad("HST");
    const guest = await squad("GST");
    const other = await squad("OTH");

    const listed = await list(host.captain.token);
    const requested = await app.server.inject({
      method: "POST",
      url: `/scrims/${listed.json().listingId}/request`,
      headers: authed(guest.captain.token),
    });
    await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requested.json().requestId}/decide`,
      headers: authed(host.captain.token),
      payload: { accept: true },
    });

    const board = await app.server.inject({
      method: "GET",
      url: "/scrims",
      headers: authed(other.captain.token),
    });
    expect(board.json().listings).toHaveLength(0);
  });

  it("declining leaves the listing up for someone else", async () => {
    const host = await squad("HST");
    const guest = await squad("GST");

    const listed = await list(host.captain.token);
    const requested = await app.server.inject({
      method: "POST",
      url: `/scrims/${listed.json().listingId}/request`,
      headers: authed(guest.captain.token),
    });
    const declined = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requested.json().requestId}/decide`,
      headers: authed(host.captain.token),
      payload: { accept: false },
    });

    expect(declined.json().accepted).toBe(false);

    const board = await app.server.inject({
      method: "GET",
      url: "/scrims",
      headers: authed(guest.captain.token),
    });
    expect(board.json().listings).toHaveLength(1);
    expect(board.json().listings[0].requested).toBe(false);
  });

  it("puts the request back when the match cannot be committed", async () => {
    const host = await squad("HST");
    const guest = await squad("GST");

    const listed = await list(host.captain.token);
    const requested = await app.server.inject({
      method: "POST",
      url: `/scrims/${listed.json().listingId}/request`,
      headers: authed(guest.captain.token),
    });

    // A guest joins the PUG queue between asking and being answered.
    await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(guest.members[2]!.token),
      payload: { regions: ["na"] },
    });

    const accepted = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requested.json().requestId}/decide`,
      headers: authed(host.captain.token),
      payload: { accept: true },
    });

    expect(accepted.statusCode).toBe(409);
    expect(accepted.json().error).toBe("PLAYER_QUEUED");

    // The arrangement survives, so the host can try again once they are free.
    const board = await app.server.inject({
      method: "GET",
      url: "/scrims",
      headers: authed(host.captain.token),
    });
    expect(board.json().incoming).toHaveLength(1);
  });

  it("keeps a member out of arranging scrims", async () => {
    const host = await squad("HST");

    const res = await app.server.inject({
      method: "POST",
      url: "/scrims",
      headers: authed(host.members[2]!.token),
      payload: { region: "na", note: null },
    });
    expect(res.statusCode).toBe(403);
  });

  it("never puts a rating on the board", async () => {
    const host = await squad("HST");
    const guest = await squad("GST");
    await list(host.captain.token);

    const board = await app.server.inject({
      method: "GET",
      url: "/scrims",
      headers: authed(guest.captain.token),
    });

    expectNoRatings(board.json());
    // Null rather than a rank, because these accounts have no games yet: a
    // roster nobody has placed on reads as unranked, not as average.
    expect(board.json().listings[0]).toHaveProperty("tier");
    expect(board.json().listings[0].tier).toBeNull();
  });
});

describe("chat channels", () => {
  /** Ten queued solos, matched, so the match channels exist. */
  async function matchTen() {
    const players = [];
    for (let i = 0; i < 10; i += 1) {
      const u = await login();
      await app.server.inject({
        method: "POST",
        url: "/queue/join",
        headers: authed(u.token),
        payload: { regions: ["na"] },
      });
      players.push(u);
    }

    await app.matchmaker.runPass();
    const [match] = await handle.db
      .select()
      .from(matches)
      .orderBy(desc(matches.createdAt))
      .limit(1);

    const view = (await app.services.lifecycle.view(match!.id))!;
    const tokenFor = new Map(players.map((p) => [p.userId, p.token]));
    // A roster player is keyed `id`, not `userId` -- the view publishes a
    // player, not a participant row.
    const onTeam1 = tokenFor.get(view.team1[0]?.id ?? "");
    const onTeam2 = tokenFor.get(view.team2[0]?.id ?? "");
    if (!onTeam1 || !onTeam2) throw new Error("staging failed: could not match a roster to a token");

    return {
      matchId: match!.id,
      view,
      onTeam1,
      onTeam2,
    };
  }

  const read = (channel: string, token: string) =>
    app.server.inject({ method: "GET", url: `/chat/${channel}`, headers: authed(token) });

  async function partyIdOf(token: string) {
    const res = await app.server.inject({ method: "GET", url: "/party", headers: authed(token) });
    return res.json().partyId as string;
  }

  it("lets a party read its own channel", async () => {
    const a = await login();
    const res = await read(`party:${await partyIdOf(a.token)}`, a.token);

    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toEqual([]);
  });

  it("keeps everyone else out of it", async () => {
    const a = await login();
    const stranger = await login();

    const res = await read(`party:${await partyIdOf(a.token)}`, stranger.token);
    expect(res.statusCode).toBe(403);
  });

  it("lets both sides of a match read the match channel", async () => {
    const { matchId, onTeam1, onTeam2 } = await matchTen();

    expect((await read(`match:${matchId}`, onTeam1)).statusCode).toBe(200);
    expect((await read(`match:${matchId}`, onTeam2)).statusCode).toBe(200);
  });

  it("keeps a team channel to that team", async () => {
    const { matchId, onTeam1, onTeam2 } = await matchTen();

    expect((await read(`match:${matchId}:t1`, onTeam1)).statusCode).toBe(200);
    expect((await read(`match:${matchId}:t2`, onTeam2)).statusCode).toBe(200);

    // The whole point of a team channel is that the other five cannot read it.
    expect((await read(`match:${matchId}:t2`, onTeam1)).statusCode).toBe(403);
    expect((await read(`match:${matchId}:t1`, onTeam2)).statusCode).toBe(403);
  });

  it("keeps someone outside the match out of all of it", async () => {
    const { matchId } = await matchTen();
    const outsider = await login();

    for (const channel of [`match:${matchId}`, `match:${matchId}:t1`, `match:${matchId}:t2`]) {
      expect((await read(channel, outsider.token)).statusCode).toBe(403);
    }
  });

  it("refuses a channel that does not belong to anything", async () => {
    const a = await login();

    for (const channel of [
      "nonsense",
      "party:00000000-0000-0000-0000-000000000000",
      "match:00000000-0000-0000-0000-000000000000",
      "match:00000000-0000-0000-0000-000000000000:t3",
    ]) {
      expect((await read(channel, a.token)).statusCode).toBe(403);
    }
  });

  it("needs a session at all", async () => {
    const res = await app.server.inject({ method: "GET", url: "/chat/party:whatever" });
    expect(res.statusCode).toBe(401);
  });
});

describe("Game Masters", () => {
  /** Promotes an account the way the grant script does. */
  async function makeGameMaster(userId: string) {
    await handle.db.update(users).set({ role: "game_master" }).where(eq(users.id, userId));
  }

  /** A match both captains have reported differently on. */
  async function disputedMatch() {
    const players = [];
    for (let i = 0; i < 10; i += 1) {
      const u = await login();
      await app.server.inject({
        method: "POST",
        url: "/queue/join",
        headers: authed(u.token),
        payload: { regions: ["na"] },
      });
      players.push(u);
    }

    await app.matchmaker.runPass();
    const [match] = await handle.db
      .select()
      .from(matches)
      .orderBy(desc(matches.createdAt))
      .limit(1);

    await handle.db.update(matches).set({ state: "LIVE" }).where(eq(matches.id, match!.id));

    const view = (await app.services.lifecycle.view(match!.id))!;
    const tokenFor = new Map(players.map((p) => [p.userId, p.token]));
    const cap1 = tokenFor.get(view.captain1!)!;
    const cap2 = tokenFor.get(view.captain2!)!;

    // Each captain claims their own side won.
    await app.server.inject({
      method: "POST",
      url: `/match/${match!.id}/report`,
      headers: authed(cap1),
      payload: { winner: "TEAM1" },
    });
    await app.server.inject({
      method: "POST",
      url: `/match/${match!.id}/report`,
      headers: authed(cap2),
      payload: { winner: "TEAM2" },
    });

    return { matchId: match!.id, players, view, cap1, cap2 };
  }

  it("keeps a player out of the dispute queue", async () => {
    const a = await login();
    const res = await app.server.inject({
      method: "GET",
      url: "/mod/disputes",
      headers: authed(a.token),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/Game Master/i);
  });

  it("shows a Game Master both claims, not just an id", async () => {
    const { matchId } = await disputedMatch();
    const gm = await login();
    await makeGameMaster(gm.userId);

    const res = await app.server.inject({
      method: "GET",
      url: "/mod/disputes",
      headers: authed(gm.token),
    });

    expect(res.statusCode).toBe(200);
    const [dispute] = res.json();
    expect(dispute.matchId).toBe(matchId);
    expect(dispute.type).toBe("PUG");

    // A list of ids is not a queue anyone can work.
    expect(dispute.reports).toHaveLength(2);
    expect(dispute.reports.map((r: { claimedWinner: string }) => r.claimedWinner).sort()).toEqual([
      "TEAM1",
      "TEAM2",
    ]);
    expect(dispute.reports[0].discordName).toBeTruthy();
  });

  it("lets a Game Master read a match they are not in", async () => {
    const { matchId } = await disputedMatch();
    const gm = await login();
    await makeGameMaster(gm.userId);

    // Ruling on a match means seeing who played it.
    const res = await app.server.inject({
      method: "GET",
      url: `/match/${matchId}`,
      headers: authed(gm.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().team1).toHaveLength(5);
  });

  it("settles a dispute and moves rating once", async () => {
    const { matchId, view } = await disputedMatch();
    const gm = await login();
    await makeGameMaster(gm.userId);

    const winnerId = view.team1[0]!.id;
    const [before] = await handle.db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.userId, winnerId));

    const res = await app.server.inject({
      method: "POST",
      url: `/mod/disputes/${matchId}/resolve`,
      headers: authed(gm.token),
      payload: { winner: "TEAM1", note: "Scoreboard screenshot matches TEAM1." },
    });
    expect(res.statusCode).toBe(200);

    const [after] = await handle.db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.userId, winnerId));
    expect(after!.rating).toBeGreaterThan(before!.rating);

    // A ruling is final; the queue should not still be offering it.
    const remaining = await app.server.inject({
      method: "GET",
      url: "/mod/disputes",
      headers: authed(gm.token),
    });
    expect(remaining.json()).toHaveLength(0);
  });

  it("insists on a note, since a ruling has to say why", async () => {
    const { matchId } = await disputedMatch();
    const gm = await login();
    await makeGameMaster(gm.userId);

    const res = await app.server.inject({
      method: "POST",
      url: `/mod/disputes/${matchId}/resolve`,
      headers: authed(gm.token),
      payload: { winner: "TEAM1", note: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("will not let a player rule on their own match", async () => {
    const { matchId, cap1 } = await disputedMatch();

    const res = await app.server.inject({
      method: "POST",
      url: `/mod/disputes/${matchId}/resolve`,
      headers: authed(cap1),
      payload: { winner: "TEAM1", note: "we definitely won" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("marks a Game Master everywhere their name is published", async () => {
    const gm = await login();
    await makeGameMaster(gm.userId);

    const me = await app.server.inject({ method: "GET", url: "/me", headers: authed(gm.token) });
    expect(me.json().isGameMaster).toBe(true);

    const party = await app.server.inject({
      method: "GET",
      url: "/party",
      headers: authed(gm.token),
    });
    expect(party.json().members[0].isGameMaster).toBe(true);

    const conn = { send: () => {}, close: () => {} };
    app.notifier.add(gm.userId, conn);
    const other = await login();
    const online = await app.server.inject({
      method: "GET",
      url: "/players/online",
      headers: authed(other.token),
    });
    expect(online.json().players.find((p: { id: string }) => p.id === gm.userId).isGameMaster).toBe(
      true,
    );
    app.notifier.remove(gm.userId, conn);

    const profile = await app.server.inject({
      method: "GET",
      url: `/players/${gm.userId}`,
      headers: authed(other.token),
    });
    expect(profile.json().isGameMaster).toBe(true);
  });

  it("leaves an ordinary player unmarked", async () => {
    const a = await login();
    const me = await app.server.inject({ method: "GET", url: "/me", headers: authed(a.token) });
    expect(me.json().isGameMaster).toBe(false);
  });
});

describe("scrim lineups", () => {
  /** A registered team of any size, built through the routes. */
  async function squad(tag: string, size: number) {
    const captain = await login();
    const created = await app.server.inject({
      method: "POST",
      url: "/teams",
      headers: authed(captain.token),
      payload: { tag, name: `${tag} Squad`, region: "na" },
    });
    const teamId = created.json().teamId as string;

    const members = [captain];
    for (let i = 1; i < size; i += 1) {
      const u = await login();
      const applied = await app.server.inject({
        method: "POST",
        url: `/teams/${teamId}/apply`,
        headers: authed(u.token),
        payload: {},
      });
      await app.server.inject({
        method: "POST",
        url: `/team/applications/${applied.json().applicationId}/decide`,
        headers: authed(captain.token),
        payload: { accept: true },
      });
      members.push(u);
    }

    goOnline(...members.map((m) => m.userId));
    return { teamId, captain, members };
  }

  async function arrange(host: Awaited<ReturnType<typeof squad>>, guest: Awaited<ReturnType<typeof squad>>) {
    const listed = await app.server.inject({
      method: "POST",
      url: "/scrims",
      headers: authed(host.captain.token),
      payload: { region: "na", note: null },
    });
    const requested = await app.server.inject({
      method: "POST",
      url: `/scrims/${listed.json().listingId}/request`,
      headers: authed(guest.captain.token),
    });
    const accepted = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requested.json().requestId}/decide`,
      headers: authed(host.captain.token),
      payload: { accept: true },
    });

    return { listingId: listed.json().listingId, requestId: requested.json().requestId, accepted };
  }

  const myTeam = (token: string) =>
    app.server.inject({ method: "GET", url: "/me/team", headers: authed(token) });

  const board = (token: string) =>
    app.server.inject({ method: "GET", url: "/scrims", headers: authed(token) });

  it("makes the first five starters and the rest substitutes", async () => {
    const { captain } = await squad("ACE", 7);
    const roster = (await myTeam(captain.token)).json().team.members;

    expect(roster.filter((m: { isStarter: boolean }) => m.isStarter)).toHaveLength(5);
    // Starters sort to the top, so the roster reads as the lineup it is.
    expect(roster.slice(0, 5).every((m: { isStarter: boolean }) => m.isStarter)).toBe(true);
    expect(roster.slice(5).every((m: { isStarter: boolean }) => !m.isStarter)).toBe(true);
  });

  it("lets the captain swap someone onto the bench and back", async () => {
    const { captain, members } = await squad("ACE", 7);
    const sub = members[6]!;
    const starter = members[1]!;

    const overfull = await app.server.inject({
      method: "POST",
      url: `/team/members/${sub.userId}/starter`,
      headers: authed(captain.token),
      payload: { starting: true },
    });
    // Refused rather than silently dropping somebody: which five is the
    // captain's call.
    expect(overfull.statusCode).toBe(409);
    expect(overfull.json().error).toBe("TOO_MANY_STARTERS");

    await app.server.inject({
      method: "POST",
      url: `/team/members/${starter.userId}/starter`,
      headers: authed(captain.token),
      payload: { starting: false },
    });
    const now = await app.server.inject({
      method: "POST",
      url: `/team/members/${sub.userId}/starter`,
      headers: authed(captain.token),
      payload: { starting: true },
    });
    expect(now.statusCode).toBe(200);
  });

  it("is the captain's call, not an officer's", async () => {
    const { captain, members } = await squad("ACE", 6);
    const officer = members[1]!;
    await app.server.inject({
      method: "POST",
      url: `/team/members/${officer.userId}/role`,
      headers: authed(captain.token),
      payload: { role: "officer" },
    });

    const res = await app.server.inject({
      method: "POST",
      url: `/team/members/${members[5]!.userId}/starter`,
      headers: authed(officer.token),
      payload: { starting: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it("skips the confirmation when both rosters are exactly five", async () => {
    const host = await squad("HST", 5);
    const guest = await squad("GST", 5);
    const { accepted } = await arrange(host, guest);

    // Nothing to choose, so nobody is asked and the match goes straight out.
    expect(accepted.json().matchId).toBeTruthy();
    expect(accepted.json().awaitingLineup).toBeUndefined();
  });

  it("asks both captains when a roster carries substitutes", async () => {
    const host = await squad("HST", 7);
    const guest = await squad("GST", 5);
    const { accepted } = await arrange(host, guest);

    expect(accepted.json().awaitingLineup).toBe(true);
    expect(accepted.json().matchId).toBeUndefined();

    // The host has to pick; the guest of five does not.
    const hostBoard = await board(host.captain.token);
    expect(hostBoard.json().pendingLineup).toBeTruthy();
    expect(hostBoard.json().pendingLineup.roster).toHaveLength(7);
    expect(hostBoard.json().pendingLineup.opponentTag).toBe("GST");

    expect((await board(guest.captain.token)).json().pendingLineup).toBeNull();
  });

  it("preselects the starters", async () => {
    const host = await squad("HST", 8);
    const guest = await squad("GST", 5);
    await arrange(host, guest);

    const pending = (await board(host.captain.token)).json().pendingLineup;
    expect(pending.roster.filter((r: { isStarter: boolean }) => r.isStarter)).toHaveLength(5);
    expect(pending.roster.slice(0, 5).every((r: { isStarter: boolean }) => r.isStarter)).toBe(true);
  });

  it("starts the match once the last captain confirms", async () => {
    const host = await squad("HST", 7);
    const guest = await squad("GST", 5);
    const { requestId } = await arrange(host, guest);

    const pending = (await board(host.captain.token)).json().pendingLineup;
    const five = pending.roster.slice(0, 5).map((r: { userId: string }) => r.userId);

    const confirmed = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requestId}/lineup`,
      headers: authed(host.captain.token),
      payload: { userIds: five },
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().matchId).toBeTruthy();

    const match = await app.server.inject({
      method: "GET",
      url: `/match/${confirmed.json().matchId}`,
      headers: authed(host.captain.token),
    });
    expect(match.json().type).toBe("SCRIM");
    expect(match.json().team1.map((p: { id: string }) => p.id).sort()).toEqual(five.sort());
  });

  it("lets a captain field a substitute over a starter", async () => {
    const host = await squad("HST", 7);
    const guest = await squad("GST", 5);
    const { requestId } = await arrange(host, guest);

    const pending = (await board(host.captain.token)).json().pendingLineup;
    const benched = pending.roster.filter((r: { isStarter: boolean }) => !r.isStarter)[0]!;
    const chosen = [
      ...pending.roster.slice(0, 4).map((r: { userId: string }) => r.userId),
      benched.userId,
    ];

    const confirmed = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requestId}/lineup`,
      headers: authed(host.captain.token),
      payload: { userIds: chosen },
    });

    // Starters are a default, not a rule.
    expect(confirmed.statusCode).toBe(200);
    const match = await app.server.inject({
      method: "GET",
      url: `/match/${confirmed.json().matchId}`,
      headers: authed(host.captain.token),
    });
    expect(match.json().team1.map((p: { id: string }) => p.id)).toContain(benched.userId);
  });

  it("refuses a lineup that is not five of your own", async () => {
    const host = await squad("HST", 7);
    const guest = await squad("GST", 5);
    const { requestId } = await arrange(host, guest);

    const pending = (await board(host.captain.token)).json().pendingLineup;
    const ids = pending.roster.map((r: { userId: string }) => r.userId);

    const tooFew = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requestId}/lineup`,
      headers: authed(host.captain.token),
      payload: { userIds: ids.slice(0, 4) },
    });
    expect(tooFew.json().error).toBe("BAD_LINEUP");

    const notMine = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requestId}/lineup`,
      headers: authed(host.captain.token),
      payload: { userIds: [...ids.slice(0, 4), guest.captain.userId] },
    });
    expect(notMine.json().error).toBe("BAD_LINEUP");
  });

  it("only the captain may confirm it", async () => {
    const host = await squad("HST", 7);
    const guest = await squad("GST", 5);
    const { requestId } = await arrange(host, guest);

    const pending = (await board(host.captain.token)).json().pendingLineup;
    const five = pending.roster.slice(0, 5).map((r: { userId: string }) => r.userId);

    const res = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requestId}/lineup`,
      headers: authed(host.members[1]!.token),
      payload: { userIds: five },
    });
    expect(res.statusCode).toBe(403);
  });

  it("drops the scrim and keeps the listing down when nobody confirms", async () => {
    const host = await squad("HST", 7);
    const guest = await squad("GST", 5);
    const other = await squad("OTH", 5);
    const { requestId } = await arrange(host, guest);

    await handle.db
      .update(scrimRequests)
      .set({ confirmDeadline: new Date(Date.now() - 1000) })
      .where(eq(scrimRequests.id, requestId));
    await app.sweepScrims();

    // The host said yes and then did not field a team, so they re-post when
    // they are actually ready.
    expect((await board(other.captain.token)).json().listings).toHaveLength(0);
    expect((await board(host.captain.token)).json().pendingLineup).toBeNull();

    const late = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requestId}/lineup`,
      headers: authed(host.captain.token),
      payload: { userIds: [] },
    });
    expect(late.json().error).toBe("NOT_CONFIRMING");
  });

  it("penalises nobody for a lineup that never came", async () => {
    const host = await squad("HST", 7);
    const guest = await squad("GST", 5);
    const { requestId } = await arrange(host, guest);

    await handle.db
      .update(scrimRequests)
      .set({ confirmDeadline: new Date(Date.now() - 1000) })
      .where(eq(scrimRequests.id, requestId));
    await app.sweepScrims();

    // The accept prompt never went out, so nobody lost a match over it.
    const me = await app.server.inject({
      method: "GET",
      url: "/me",
      headers: authed(guest.captain.token),
    });
    expect(me.json().queueCooldownSeconds).toBe(0);
    expect(me.json().missedAccepts).toBe(0);
  });
});

describe("a team has to be present to scrim", () => {
  async function squad(tag: string, size = 5) {
    const captain = await login();
    const created = await app.server.inject({
      method: "POST",
      url: "/teams",
      headers: authed(captain.token),
      payload: { tag, name: `${tag} Squad`, region: "na" },
    });
    const teamId = created.json().teamId as string;

    const members = [captain];
    for (let i = 1; i < size; i += 1) {
      const u = await login();
      const applied = await app.server.inject({
        method: "POST",
        url: `/teams/${teamId}/apply`,
        headers: authed(u.token),
        payload: {},
      });
      await app.server.inject({
        method: "POST",
        url: `/team/applications/${applied.json().applicationId}/decide`,
        headers: authed(captain.token),
        payload: { accept: true },
      });
      members.push(u);
    }

    // One officer, so a test can act as somebody other than the captain
    // without tripping the permission check before the readiness one.
    if (members[1]) {
      await app.server.inject({
        method: "POST",
        url: `/team/members/${members[1].userId}/role`,
        headers: authed(captain.token),
        payload: { role: "officer" },
      });
    }

    goOnline(...members.map((m) => m.userId));
    return { teamId, captain, members };
  }

  const list = (token: string) =>
    app.server.inject({
      method: "POST",
      url: "/scrims",
      headers: authed(token),
      payload: { region: "na", note: null },
    });

  it("refuses to list a team whose captain has gone", async () => {
    const host = await squad("HST");
    goOffline(host.captain.userId);

    const res = await list(host.members[1]!.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("CAPTAIN_OFFLINE");
    // Only the captain confirms a lineup and only the captain reports, so a
    // scrim without them is one nobody can finish.
    expect(res.json().message).toMatch(/captain is offline/i);
  });

  it("refuses to list a team that is short of five", async () => {
    const host = await squad("HST");
    goOffline(host.members[4]!.userId);

    const res = await list(host.captain.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NOT_ENOUGH_ONLINE");
    expect(res.json().message).toMatch(/not have enough players online/i);
  });

  it("says how many are actually here", async () => {
    const host = await squad("HST");
    goOffline(host.members[3]!.userId);
    goOffline(host.members[4]!.userId);

    const res = await list(host.captain.token);
    expect(res.json().message).toMatch(/3 of 5/);
  });

  it("lists once everyone is back", async () => {
    const host = await squad("HST");
    goOffline(host.members[2]!.userId);
    expect((await list(host.captain.token)).statusCode).toBe(409);

    goOnline(host.members[2]!.userId);
    expect((await list(host.captain.token)).statusCode).toBe(200);
  });

  it("holds a requesting team to the same rule", async () => {
    const host = await squad("HST");
    const guest = await squad("GST");
    const listed = await list(host.captain.token);

    goOffline(guest.captain.userId);
    const res = await app.server.inject({
      method: "POST",
      url: `/scrims/${listed.json().listingId}/request`,
      headers: authed(guest.members[1]!.token),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("CAPTAIN_OFFLINE");
  });

  it("checks again when the request is answered", async () => {
    const host = await squad("HST");
    const guest = await squad("GST");
    const listed = await list(host.captain.token);
    const requested = await app.server.inject({
      method: "POST",
      url: `/scrims/${listed.json().listingId}/request`,
      headers: authed(guest.captain.token),
    });

    // Everyone was here when they asked, and two of them went home while the
    // host was deciding. This is the moment ten people get committed.
    goOffline(guest.members[3]!.userId);
    goOffline(guest.members[4]!.userId);

    const accepted = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requested.json().requestId}/decide`,
      headers: authed(host.captain.token),
      payload: { accept: true },
    });

    expect(accepted.statusCode).toBe(409);
    expect(accepted.json().error).toBe("NOT_ENOUGH_ONLINE");

    // Nothing was consumed: the request is still there for when they return.
    const board = await app.server.inject({
      method: "GET",
      url: "/scrims",
      headers: authed(host.captain.token),
    });
    expect(board.json().incoming).toHaveLength(1);
  });

  it("still lets a request be declined by an absent team", async () => {
    const host = await squad("HST");
    const guest = await squad("GST");
    const listed = await list(host.captain.token);
    const requested = await app.server.inject({
      method: "POST",
      url: `/scrims/${listed.json().listingId}/request`,
      headers: authed(guest.captain.token),
    });

    goOffline(guest.members[2]!.userId);

    // Saying no commits nobody to anything, so it is never blocked.
    const declined = await app.server.inject({
      method: "POST",
      url: `/scrims/requests/${requested.json().requestId}/decide`,
      headers: authed(host.captain.token),
      payload: { accept: false },
    });
    expect(declined.statusCode).toBe(200);
    expect(declined.json().accepted).toBe(false);
  });

  it("does not stop a team taking its own listing down", async () => {
    const host = await squad("HST");
    await list(host.captain.token);
    goOffline(host.captain.userId);

    // Tidying up after yourself is not arranging a match.
    const res = await app.server.inject({
      method: "DELETE",
      url: "/scrims/mine",
      headers: authed(host.members[1]!.token),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("population counters", () => {
  beforeEach(async () => {
    // The broadcaster outlives each test, so a coalesced refresh scheduled by
    // an earlier one can land inside this one and be mistaken for the push
    // under test. Clearing the timer and syncing to the freshly truncated
    // database means anything heard from here was caused here.
    app.population.stop();
    await app.population.refresh();
  });

  /** A socket that keeps what it was told, rather than dropping it. */
  function listen(userId: string) {
    const heard: { type: string; online?: number; inQueue?: number; inMatch?: number }[] = [];
    const conn = {
      send: (payload: string) => heard.push(JSON.parse(payload)),
      close: () => {},
    };
    app.notifier.add(userId, conn);
    connections.push({ userId, conn: conn as unknown as { send: () => void; close: () => void } });
    return {
      counts: () => heard.filter((e) => e.type === "queue.counts"),
    };
  }

  /** The broadcast is coalesced, so it lands a beat after the request does. */
  async function untilCounted(
    read: () => { inQueue?: number; inMatch?: number; online?: number }[],
    timeoutMs = 3000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (read().length > 0) return read();
      await new Promise((r) => setTimeout(r, 25));
    }
    return read();
  }

  it("tells a socket the queue grew, without it asking", async () => {
    const user = await login();
    const socket = listen(user.userId);

    const res = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(user.token),
      payload: { regions: ["na"] },
    });
    expect(res.statusCode).toBe(200);

    const counts = await untilCounted(socket.counts);
    expect(counts.at(-1)).toMatchObject({ type: "queue.counts", inQueue: 1 });
  });

  it("tells them again when it shrinks", async () => {
    const user = await login();
    const socket = listen(user.userId);

    await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(user.token),
      payload: { regions: ["na"] },
    });
    await untilCounted(socket.counts);

    await app.server.inject({
      method: "POST",
      url: "/queue/leave",
      headers: authed(user.token),
    });

    await untilCounted(() => socket.counts().filter((c) => c.inQueue === 0));
    expect(socket.counts().at(-1)).toMatchObject({ inQueue: 0 });
  });

  it("reaches people who had nothing to do with the change", async () => {
    const actor = await login();
    const bystander = await login();
    const watching = listen(bystander.userId);
    listen(actor.userId);

    await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(actor.token),
      payload: { regions: ["na"] },
    });

    // The whole reason this is pushed rather than polled: the numbers move for
    // reasons that never reach you.
    const counts = await untilCounted(watching.counts);
    expect(counts.at(-1)).toMatchObject({ inQueue: 1 });
  });

  it("still answers the route, for anyone without a socket", async () => {
    const user = await login();
    await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(user.token),
      payload: { regions: ["na"] },
    });

    const res = await app.server.inject({ method: "GET", url: "/queue/stats" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inQueue: 1 });
  });

  it("publishes counts and nothing else", async () => {
    const user = await login();
    const socket = listen(user.userId);
    await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(user.token),
      payload: { regions: ["na"] },
    });

    const counts = await untilCounted(socket.counts);
    // These go to everyone on the server, so they are the last place a rating
    // should ever turn up.
    expect(Object.keys(counts.at(-1)!).sort()).toEqual([
      "inMatch",
      "inQueue",
      "online",
      "type",
    ]);
    expectNoRatings(counts.at(-1));
  });
});

describe("suspending an account", () => {
  /** A socket that reports whether it was closed, not just what it heard. */
  function watched(userId: string) {
    const heard: { type: string; text?: string }[] = [];
    let closed = false;
    const conn = {
      send: (payload: string) => heard.push(JSON.parse(payload)),
      close: () => { closed = true; },
    };
    app.notifier.add(userId, conn);
    connections.push({ userId, conn: conn as unknown as { send: () => void; close: () => void } });
    return { heard, wasClosed: () => closed };
  }

  async function makeGameMaster() {
    const gm = await login();
    await handle.db.update(users).set({ role: "game_master" }).where(eq(users.id, gm.userId));
    return gm;
  }

  const suspend = async (
    gm: { token: string },
    targetId: string,
    body: Record<string, unknown>,
  ) =>
    app.server.inject({
      method: "POST",
      url: `/mod/users/${targetId}/suspend`,
      headers: authed(gm.token),
      payload: body,
    });

  it("is refused to an ordinary player", async () => {
    const player = await login();
    const target = await login();

    const res = await suspend(player, target.userId, { hours: 24, reason: "because" });
    expect(res.statusCode).toBe(403);
  });

  it("ends the session there and then, not at their next login", async () => {
    const gm = await makeGameMaster();
    const target = await login();

    const before = await app.server.inject({ method: "GET", url: "/me", headers: authed(target.token) });
    expect(before.statusCode).toBe(200);

    await suspend(gm, target.userId, { hours: 24, reason: "Throwing matches" });

    // Otherwise someone already signed in and queueing is not suspended at all.
    const after = await app.server.inject({ method: "GET", url: "/me", headers: authed(target.token) });
    expect(after.statusCode).toBe(401);
  });

  it("tells them why before it takes the socket away", async () => {
    const gm = await makeGameMaster();
    const target = await login();
    const socket = watched(target.userId);

    await suspend(gm, target.userId, { hours: 24, reason: "Throwing matches" });

    // The order matters: a closed socket cannot deliver an explanation, and
    // being disconnected with no reason is how you get an angry DM.
    const told = socket.heard.find((e) => e.type === "notification");
    expect(told?.text).toContain("Throwing matches");
    expect(socket.wasClosed()).toBe(true);
  });

  it("takes the seat they were holding in the queue", async () => {
    const gm = await makeGameMaster();
    const target = await login();
    watched(target.userId);

    await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(target.token),
      payload: { regions: ["na"] },
    });
    expect(await app.services.queue.countQueuedPlayers()).toBe(1);

    await suspend(gm, target.userId, { hours: 24, reason: "Throwing matches" });

    expect(await app.services.queue.countQueuedPlayers()).toBe(0);
  });

  it("keeps them out afterwards", async () => {
    const gm = await makeGameMaster();
    const target = await login();
    await suspend(gm, target.userId, { hours: 24, reason: "Throwing matches" });

    // A fresh session, the way they would get one by signing in again.
    const again = await app.services.sessions.create(target.userId);
    const res = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(again.token),
      payload: { regions: ["na"] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("BANNED");
  });

  it("refuses a duration outside the bounds", async () => {
    const gm = await makeGameMaster();
    const target = await login();

    const res = await suspend(gm, target.userId, { hours: 0, reason: "because" });
    expect(res.statusCode).toBe(400);
  });

  it("refuses one with no reason", async () => {
    const gm = await makeGameMaster();
    const target = await login();

    const res = await suspend(gm, target.userId, { hours: 24 });
    expect(res.statusCode).toBe(400);
  });

  it("lets a Game Master lift it again", async () => {
    const gm = await makeGameMaster();
    const target = await login();
    await suspend(gm, target.userId, { hours: 24, reason: "Throwing matches" });

    const res = await app.server.inject({
      method: "POST",
      url: `/mod/users/${target.userId}/reinstate`,
      headers: authed(gm.token),
      payload: { note: "Appealed" },
    });
    expect(res.statusCode).toBe(200);

    const again = await app.services.sessions.create(target.userId);
    const queued = await app.server.inject({
      method: "POST",
      url: "/queue/join",
      headers: authed(again.token),
      payload: { regions: ["na"] },
    });
    expect(queued.statusCode).toBe(200);
  });

  it("lists who is serving one, and what was done to them", async () => {
    const gm = await makeGameMaster();
    const target = await login();
    await suspend(gm, target.userId, { hours: 24, reason: "Throwing matches" });

    const list = await app.server.inject({
      method: "GET",
      url: "/mod/suspensions",
      headers: authed(gm.token),
    });
    expect(list.json().users.map((u: { userId: string }) => u.userId)).toContain(target.userId);

    const history = await app.server.inject({
      method: "GET",
      url: `/mod/users/${target.userId}/history`,
      headers: authed(gm.token),
    });
    expect(history.json().entries[0]).toMatchObject({ eventType: "user.suspended" });
  });

  it("finds an account without publishing a rating", async () => {
    const gm = await makeGameMaster();
    const target = await login();
    await handle.db.update(users).set({ discordName: "Griefer99" }).where(eq(users.id, target.userId));

    const res = await app.server.inject({
      method: "GET",
      url: "/mod/users?q=grief",
      headers: authed(gm.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().users.map((u: { userId: string }) => u.userId)).toContain(target.userId);
    expectNoRatings(res.json());
  });

  it("keeps the search away from ordinary players", async () => {
    const player = await login();
    const res = await app.server.inject({
      method: "GET",
      url: "/mod/users?q=a",
      headers: authed(player.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("telling a client what this deployment is", () => {
  it("serves the shape of the game without a session", async () => {
    // The sign-in screen needs the name before anyone has signed in.
    const res = await app.server.inject({ method: "GET", url: "/config" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      appName: expect.any(String),
      gameName: expect.any(String),
      teamSize: 5,
      matchSize: 10,
      maxPartySize: 5,
    });
  });

  it("names the regions and ranks a client cannot compile in", async () => {
    const body = (await app.server.inject({ method: "GET", url: "/config" })).json();

    expect(body.regions[0]).toMatchObject({
      id: expect.any(String),
      label: expect.any(String),
      name: expect.any(String),
    });
    // Index-aligned, which is the contract the client draws a ladder from.
    expect(body.tiers).toHaveLength(body.tierFloors.length);
  });

  it("publishes no rating a player could read a ladder position from", async () => {
    const body = (await app.server.inject({ method: "GET", url: "/config" })).json();

    // The floors are public by necessity -- they are what rank names mean --
    // but nothing here may carry a person's rating.
    expect(body).not.toHaveProperty("rating");
    expect(body.tierFloors.every((f: number) => typeof f === "number")).toBe(true);
  });
});
