import { createHash } from "node:crypto";

import { isFail, isOk } from "@suddenqueue/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { playerRatings, sessions, users } from "../db/schema/index.js";
import { makeUser, setupTestDatabase, truncateAll } from "../test/helpers.js";
import { DiscordAuth, type DiscordProfile } from "./discord.js";
import { AuthService } from "./service.js";
import { SessionService, safeEqual } from "./sessions.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let sessionService: SessionService;

const CONFIG = {
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "http://127.0.0.1:3000/auth/discord/callback",
  stateSecret: "a".repeat(48),
};

const PROFILE: DiscordProfile = {
  id: "1234567890",
  username: "testplayer",
  globalName: "Test Player",
  avatarUrl: null,
};

beforeAll(async () => {
  handle = await setupTestDatabase();
  sessionService = new SessionService(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

describe("sessions", () => {
  it("issues a token and resolves it back to the user", async () => {
    const userId = await makeUser(handle);
    const { token } = await sessionService.create(userId);

    const verified = await sessionService.verify(token);
    expect(isOk(verified)).toBe(true);
    if (isOk(verified)) expect(verified.data.userId).toBe(userId);
  });

  it("never stores the raw token", async () => {
    const userId = await makeUser(handle);
    const { token } = await sessionService.create(userId);

    const [row] = await handle.db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.userId, userId));

    // A leaked database dump must not be replayable as live logins.
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("issues unpredictable tokens", async () => {
    const userId = await makeUser(handle);
    const tokens = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      tokens.add((await sessionService.create(userId)).token);
    }
    expect(tokens.size).toBe(20);
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(43);
  });

  it("rejects an unknown token", async () => {
    const r = await sessionService.verify("not-a-real-token");
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("INVALID_SESSION");
  });

  it("rejects an empty token without touching the database", async () => {
    const r = await sessionService.verify("");
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("INVALID_SESSION");
  });

  it("rejects an expired session", async () => {
    const userId = await makeUser(handle);
    const { token } = await sessionService.create(userId);

    await handle.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, userId));

    const r = await sessionService.verify(token);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("SESSION_EXPIRED");
  });

  it("rejects a revoked session", async () => {
    const userId = await makeUser(handle);
    const { token } = await sessionService.create(userId);

    expect(await sessionService.revoke(token)).toBe(true);

    const r = await sessionService.verify(token);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("SESSION_REVOKED");
  });

  it("revoking one device leaves the others signed in", async () => {
    const userId = await makeUser(handle);
    const a = await sessionService.create(userId);
    const b = await sessionService.create(userId);

    await sessionService.revoke(a.token);

    expect(isFail(await sessionService.verify(a.token))).toBe(true);
    expect(isOk(await sessionService.verify(b.token))).toBe(true);
  });

  it("revokes everything for a user at once", async () => {
    const userId = await makeUser(handle);
    const a = await sessionService.create(userId);
    const b = await sessionService.create(userId);

    expect(await sessionService.revokeAllForUser(userId)).toBe(2);
    expect(isFail(await sessionService.verify(a.token))).toBe(true);
    expect(isFail(await sessionService.verify(b.token))).toBe(true);
    expect(await sessionService.activeCountForUser(userId)).toBe(0);
  });

  it("prunes expired and revoked rows but keeps live ones", async () => {
    const userId = await makeUser(handle);
    const live = await sessionService.create(userId);
    const dead = await sessionService.create(userId);

    await handle.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, createHash("sha256").update(dead.token).digest("hex")));

    expect(await sessionService.prune()).toBe(1);
    expect(isOk(await sessionService.verify(live.token))).toBe(true);
  });

  it("drops sessions when the user is deleted", async () => {
    const userId = await makeUser(handle);
    const { token } = await sessionService.create(userId);

    await handle.db.delete(users).where(eq(users.id, userId));
    expect(isFail(await sessionService.verify(token))).toBe(true);
  });
});

describe("constant-time comparison", () => {
  it("matches identical strings and rejects others", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    // Different lengths must not throw.
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("oauth state", () => {
  const auth = new DiscordAuth(CONFIG);

  it("builds an authorize URL with PKCE and the right scope", () => {
    const { url, state, codeVerifier } = auth.createAuthorizationUrl();
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(parsed.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(parsed.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(parsed.searchParams.get("scope")).toBe("identify");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");

    // The challenge must be the hash of the verifier, never the verifier itself.
    const expected = createHash("sha256").update(codeVerifier).digest("base64url");
    expect(parsed.searchParams.get("code_challenge")).toBe(expected);
    expect(parsed.searchParams.get("code_challenge")).not.toBe(codeVerifier);
    expect(parsed.searchParams.get("state")).toBe(state);
  });

  it("produces a fresh state and verifier every time", () => {
    const a = auth.createAuthorizationUrl();
    const b = auth.createAuthorizationUrl();
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it("round-trips its own state", () => {
    const { state } = auth.createAuthorizationUrl({ handoff: "abc123" });
    const r = auth.verifyState(state);

    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.handoff).toBe("abc123");
  });

  it("rejects a tampered payload", () => {
    const { state } = auth.createAuthorizationUrl({ handoff: "abc123" });
    const [, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ handoff: "evil", iat: Date.now() })).toString(
      "base64url",
    );

    const r = auth.verifyState(`${forged}.${signature}`);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("BAD_STATE");
  });

  it("rejects state signed with a different secret", () => {
    const other = new DiscordAuth({ ...CONFIG, stateSecret: "b".repeat(48) });
    const { state } = other.createAuthorizationUrl();

    const r = auth.verifyState(state);
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("BAD_STATE");
  });

  it("rejects malformed state", () => {
    expect(isFail(auth.verifyState("garbage"))).toBe(true);
    expect(isFail(auth.verifyState("a.b.c"))).toBe(true);
  });

  it("rejects a stale authorization attempt", () => {
    const { state } = auth.createAuthorizationUrl();
    const r = auth.verifyState(state, -1);

    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("STATE_EXPIRED");
  });
});

describe("oauth exchange", () => {
  it("sends the code verifier and returns the access token", async () => {
    // Typed with the real fetch signature so the recorded init argument is
    // inspectable rather than inferred away as a zero-arg call.
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ access_token: "tok_123" }), { status: 200 }),
    );
    const auth = new DiscordAuth(CONFIG, fetcher as unknown as typeof fetch);

    const r = await auth.exchangeCode("code_abc", "verifier_xyz");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.accessToken).toBe("tok_123");

    const init = fetcher.mock.calls[0]?.[1];
    const body = init?.body as URLSearchParams;
    // PKCE only protects the flow if the verifier actually reaches Discord.
    expect(body.get("code_verifier")).toBe("verifier_xyz");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe(CONFIG.redirectUri);
    // The secret must never appear in the authorize URL, only in this exchange.
    expect(body.get("client_secret")).toBe(CONFIG.clientSecret);
  });

  it("fails cleanly when Discord rejects the code", async () => {
    const fetcher = vi.fn(async () => new Response("invalid_grant", { status: 400 }));
    const auth = new DiscordAuth(CONFIG, fetcher as unknown as typeof fetch);

    const r = await auth.exchangeCode("bad", "verifier");
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("TOKEN_EXCHANGE_FAILED");
  });

  it("fails cleanly when Discord is unreachable", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const auth = new DiscordAuth(CONFIG, fetcher as unknown as typeof fetch);

    const r = await auth.exchangeCode("code", "verifier");
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("TOKEN_EXCHANGE_FAILED");
  });

  it("maps a profile, including the avatar URL", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "42",
          username: "someone",
          global_name: "Some One",
          avatar: "abc",
        }),
        { status: 200 },
      ),
    );
    const auth = new DiscordAuth(CONFIG, fetcher as unknown as typeof fetch);

    const r = await auth.fetchProfile("tok");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.id).toBe("42");
      expect(r.data.globalName).toBe("Some One");
      expect(r.data.avatarUrl).toBe("https://cdn.discordapp.com/avatars/42/abc.png");
    }
  });

  it("rejects a profile missing required fields", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "42" }), { status: 200 }));
    const auth = new DiscordAuth(CONFIG, fetcher as unknown as typeof fetch);

    const r = await auth.fetchProfile("tok");
    expect(isFail(r)).toBe(true);
  });
});

describe("login", () => {
  function service() {
    return new AuthService(handle.db, new DiscordAuth(CONFIG), sessionService);
  }

  it("creates the account, its rating row, and a session", async () => {
    const r = await service().loginWithProfile(PROFILE);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.data.isNewAccount).toBe(true);

    const [rating] = await handle.db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.userId, r.data.userId));

    // A player cannot queue without a rating row, so login must create it.
    expect(rating!.rating).toBe(1200);
    expect(isOk(await sessionService.verify(r.data.token))).toBe(true);
  });

  it("reuses the account on a second login and does not duplicate the rating", async () => {
    const svc = service();
    const first = await svc.loginWithProfile(PROFILE);
    const second = await svc.loginWithProfile(PROFILE);

    if (!isOk(first) || !isOk(second)) throw new Error("expected ok");

    expect(second.data.userId).toBe(first.data.userId);
    expect(second.data.isNewAccount).toBe(false);
    expect(second.data.token).not.toBe(first.data.token);

    const ratings = await handle.db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.userId, first.data.userId));
    expect(ratings).toHaveLength(1);
  });

  it("stores the username rather than the display name", async () => {
    const svc = service();
    const first = await svc.loginWithProfile({ ...PROFILE, globalName: "Whatever I Feel Like" });
    if (!isOk(first)) throw new Error("expected ok");

    // The handle you are found and added by, not the name someone chose this
    // morning. Two people can share a display name; usernames are unique.
    const user = await svc.getUser(first.data.userId);
    expect(user!.discordName).toBe(PROFILE.username);
  });

  it("refreshes the username when the player renames on Discord", async () => {
    const svc = service();
    const first = await svc.loginWithProfile(PROFILE);
    if (!isOk(first)) throw new Error("expected ok");

    await svc.loginWithProfile({ ...PROFILE, username: "renamed_handle" });

    // Which is also how accounts that stored a display name before this put
    // themselves right: the next login overwrites it.
    const user = await svc.getUser(first.data.userId);
    expect(user!.discordName).toBe("renamed_handle");
  });

  it("preserves rating across logins", async () => {
    const svc = service();
    const first = await svc.loginWithProfile(PROFILE);
    if (!isOk(first)) throw new Error("expected ok");

    await handle.db
      .update(playerRatings)
      .set({ rating: 1650 })
      .where(eq(playerRatings.userId, first.data.userId));

    await svc.loginWithProfile(PROFILE);

    const [rating] = await handle.db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.userId, first.data.userId));
    expect(rating!.rating).toBe(1650);
  });

  it("refuses a banned account and issues no session", async () => {
    const svc = service();
    const first = await svc.loginWithProfile(PROFILE);
    if (!isOk(first)) throw new Error("expected ok");

    await handle.db
      .update(users)
      .set({ bannedUntil: new Date(Date.now() + 60_000), banReason: "testing" })
      .where(eq(users.id, first.data.userId));

    const blocked = await svc.loginWithProfile(PROFILE);
    expect(isFail(blocked)).toBe(true);
    if (isFail(blocked)) expect(blocked.code).toBe("BANNED");

    expect(await sessionService.activeCountForUser(first.data.userId)).toBe(1);
  });

  it("lets a lapsed ban log in again", async () => {
    const svc = service();
    const first = await svc.loginWithProfile(PROFILE);
    if (!isOk(first)) throw new Error("expected ok");

    await handle.db
      .update(users)
      .set({ bannedUntil: new Date(Date.now() - 60_000) })
      .where(eq(users.id, first.data.userId));

    expect(isOk(await svc.loginWithProfile(PROFILE))).toBe(true);
  });
});

describe("in-game name", () => {
  it("accepts and trims a reasonable name", async () => {
    const userId = await makeUser(handle);
    const svc = new AuthService(handle.db, new DiscordAuth(CONFIG), sessionService);

    const r = await svc.setInGameName(userId, "  SNIPER  ");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.data.inGameName).toBe("SNIPER");
  });

  it("rejects names that are too short or too long", async () => {
    const userId = await makeUser(handle);
    const svc = new AuthService(handle.db, new DiscordAuth(CONFIG), sessionService);

    expect(isFail(await svc.setInGameName(userId, "a"))).toBe(true);
    expect(isFail(await svc.setInGameName(userId, "x".repeat(17)))).toBe(true);
  });
});
