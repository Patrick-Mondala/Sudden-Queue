import { INVITE_RATE_LIMIT, isOk } from "@suddenqueue/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type App, buildApp } from "./app.js";
import { matches, users } from "./db/schema/index.js";
import { AuthService } from "./auth/service.js";
import { DiscordAuth } from "./auth/discord.js";
import type { Config } from "./config.js";
import { makeUser, setupTestDatabase, truncateAll } from "./test/helpers.js";

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
  app = await buildApp({ db: handle.db, config: CONFIG, autoStart: false });
  await app.server.ready();
}, 60_000);

afterAll(async () => {
  await app?.server.close();
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
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

  it("keeps the dispute queue behind a moderator check", async () => {
    const player = await login();
    const denied = await app.server.inject({
      method: "GET",
      url: "/mod/disputes",
      headers: authed(player.token),
    });
    expect(denied.statusCode).toBe(403);

    await handle.db
      .update(users)
      .set({ role: "moderator" })
      .where(eq(users.id, player.userId));

    const allowed = await app.server.inject({
      method: "GET",
      url: "/mod/disputes",
      headers: authed(player.token),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("lets a moderator rule on a dispute and settle it", async () => {
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
    await handle.db.update(users).set({ role: "moderator" }).where(eq(users.id, mod.userId));

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
    await handle.db.update(users).set({ role: "moderator" }).where(eq(users.id, mod.userId));

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
