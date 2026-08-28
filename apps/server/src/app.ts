import {
  DEFAULT_RATING,
  INVITE_EXPIRATION_SECONDS,
  MAX_PARTY_SIZE,
  PARTY_DISCONNECT_GRACE_SECONDS,
  TEAM_APPLICATION_NOTE_MAX_LENGTH,
  cooldownRemainingSeconds,
  REGIONS,
  isFail,
  isPlaced,
  placementGamesRemaining,
  tierForRating,
} from "@suddenqueue/core";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { eq, inArray, sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import { AuthService } from "./auth/service.js";
import { DiscordAuth } from "./auth/discord.js";
import { LoginHandoff } from "./auth/handoff.js";
import { SessionService, type SessionUser } from "./auth/sessions.js";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { partyInvites, partyMembers, playerRatings, users } from "./db/schema/index.js";
import { MatchLifecycle } from "./match/lifecycle.js";
import { MatchReporting } from "./match/reporting.js";
import { Matchmaker, MatchSweeper } from "./matchmaker/loop.js";
import { PartyService } from "./party/service.js";
import { TeamService } from "./team/service.js";
import { QueueRepository } from "./queue/repository.js";
import { Notifier } from "./realtime/notifier.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export interface AppDeps {
  db: Database;
  config: Config;
  /** Injected so tests can drive the loop by hand instead of on a timer. */
  autoStart?: boolean;
  /** Injected for the same reason: a test cannot wait out the real grace. */
  partyDisconnectGraceMs?: number;
}

export interface App {
  server: FastifyInstance;
  notifier: Notifier;
  matchmaker: Matchmaker;
  sweeper: MatchSweeper;
  services: {
    auth: AuthService;
    sessions: SessionService;
    party: PartyService;
    queue: QueueRepository;
    lifecycle: MatchLifecycle;
    reporting: MatchReporting;
    team: TeamService;
  };
}

const SESSION_COOKIE = "sq_session";

/** Shown in the browser tab after a desktop login completes. */
const SIGNED_IN_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Signed in</title>
<style>
  body { margin:0; height:100vh; display:grid; place-items:center;
         background:#0D1014; color:#E4E7EB;
         font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; }
  .card { text-align:center; }
  h1 { font-size:20px; letter-spacing:.02em; text-transform:uppercase; margin:0 0 8px; }
  p { color:#7C8794; font-size:14px; margin:0; }
  .mark { width:34px; height:34px; border-radius:7px; background:#2FC8BF; margin:0 auto 18px; }
</style>
<div class="card">
  <div class="mark"></div>
  <h1>Signed in to Sudden Queue</h1>
  <p>You can close this tab and return to the app.</p>
</div>`;

export async function buildApp({
  db,
  config,
  autoStart = true,
  partyDisconnectGraceMs = PARTY_DISCONNECT_GRACE_SECONDS * 1000,
}: AppDeps): Promise<App> {
  const server = Fastify({ logger: config.NODE_ENV !== "test" });

  /**
   * CORS for the desktop client.
   *
   * The Tauri webview serves the UI from localhost:1420 in dev and from a
   * tauri:// origin once bundled, while the API is a separate origin. Without
   * this the webview blocks every request before it is sent, which surfaces in
   * the client as "cannot reach the server" rather than as a CORS error.
   *
   * Origins are allow-listed rather than mirrored back: reflecting any origin
   * would let any page a user visits call this API with their session.
   */
  const allowedOrigins = new Set([
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ]);

  await server.register(cors, {
    origin(origin, cb) {
      // Same-origin and non-browser callers (curl, the desktop app's own
      // native requests) send no Origin at all.
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      // Tauri's bundled webview uses a tauri:// scheme on some platforms.
      if (origin.startsWith("tauri://")) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });

  await server.register(cookie);
  await server.register(websocket);

  /**
   * Accept body-less POSTs.
   *
   * Several actions carry no payload (logout, queue/leave, match accept), and a
   * client sending no Content-Type on those would otherwise get a 415 that
   * looks nothing like the real problem. Empty payloads pass; anything with
   * actual content still has to declare a type Fastify understands.
   */
  server.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    const buf = body as Buffer;
    if (!buf || buf.length === 0) {
      done(null, undefined);
      return;
    }
    const err = new Error("Unsupported Media Type") as Error & { statusCode?: number };
    err.statusCode = 415;
    done(err);
  });

  const notifier = new Notifier();
  const handoff = new LoginHandoff();
  const sessions = new SessionService(db);
  const discord = new DiscordAuth({
    clientId: config.DISCORD_CLIENT_ID,
    clientSecret: config.DISCORD_CLIENT_SECRET,
    redirectUri: config.DISCORD_REDIRECT_URI,
    stateSecret: config.SESSION_SECRET,
  });
  const auth = new AuthService(db, discord, sessions);
  const party = new PartyService(db);
  const team = new TeamService(db);
  const queue = new QueueRepository(db);
  const lifecycle = new MatchLifecycle(db);
  const reporting = new MatchReporting(db);

  // ---------------------------------------------------------------- realtime

  const matchmaker = new Matchmaker(queue, lifecycle, {
    onMatchCreated: async (match) => {
      const detail = await lifecycle.view(match.matchId);
      notifier.toUsers(match.userIds, {
        type: "match.found",
        matchId: match.matchId,
        acceptDeadline: match.acceptDeadline.toISOString(),
        match: detail,
      });
    },
    onTicketsPruned: async (partyIds) => {
      const userIds = await party.memberIds(partyIds);
      notifier.toUsers(userIds, {
        type: "queue.left",
        partyId: partyIds[0] ?? "",
        reason: "CONNECTION_LOST",
      });
    },
    onError: (err, ctx) => server.log.error({ err, ctx }, "matchmaker error"),
  });

  const sweeper = new MatchSweeper(lifecycle, {
    onCancelled: async (matchId, missed, kept, penalties = []) => {
      // Everyone hears about it, but only the people who missed are told they
      // are at fault — the other nine did nothing wrong, and only they are
      // told what it cost, since the cooldown is theirs alone.
      const bySeconds = new Map(penalties.map((p) => [p.userId, p.cooldownSeconds]));
      for (const userId of missed) {
        notifier.toUser(userId, {
          type: "match.cancelled",
          matchId,
          reason: "ACCEPT_TIMEOUT",
          atFault: true,
          cooldownSeconds: bySeconds.get(userId) ?? 0,
        });
      }
      notifier.toUsers(kept, {
        type: "match.cancelled",
        matchId,
        reason: "ACCEPT_TIMEOUT",
        atFault: false,
        cooldownSeconds: 0,
      });
    },
    onLive: async (matchId) => {
      const parts = await lifecycle.participants(matchId);
      notifier.toUsers(
        parts.map((p) => p.userId),
        { type: "match.state", matchId, state: "LIVE" },
      );
    },
    onDisputed: async (matchId) => {
      const parts = await lifecycle.participants(matchId);
      notifier.toUsers(
        parts.map((p) => p.userId),
        { type: "match.state", matchId, state: "DISPUTED" },
      );
    },
    onError: (err) => server.log.error({ err }, "sweeper error"),
  });

  // ------------------------------------------------------------ auth plumbing

  /** Reads the session from cookie or bearer header. */
  async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const token = bearer ?? (req.cookies as Record<string, string>)[SESSION_COOKIE];

    const result = await sessions.verify(token ?? "");
    if (isFail(result)) {
      await reply.code(401).send({ error: result.code, message: result.message });
      return;
    }

    req.user = result.data;
  }

  function requireUser(req: FastifyRequest): SessionUser {
    if (!req.user) throw new Error("route is missing the auth preHandler");
    return req.user;
  }

  // ------------------------------------------------------------------ routes

  server.get("/health", async () => ({ ok: true }));

  /**
   * Desktop login: hand back an id plus the URL to open in the user's browser.
   * The app then polls until the session lands against that id.
   */
  server.post("/auth/desktop/start", async (req) => {
    const handoffId = handoff.create();
    const base = `${req.protocol}://${req.headers.host ?? `127.0.0.1:${config.PORT}`}`;

    return {
      handoffId,
      url: `${base}/auth/discord/start?handoff=${encodeURIComponent(handoffId)}`,
      expiresInSeconds: 600,
    };
  });

  server.get("/auth/desktop/poll/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = handoff.claim(id);

    if (result.status === "expired") {
      return reply.code(410).send({ status: "expired" });
    }
    if (result.status === "error") {
      return reply.code(401).send({ status: "error", error: result.error });
    }
    return result;
  });

  server.get("/auth/discord/start", async (req, reply) => {
    const handoffId = (req.query as Record<string, string>)?.handoff;
    // Carried inside the signed state so it survives the round trip without a
    // cookie, which the browser would not share with the desktop app anyway.
    const { url, state, codeVerifier } = discord.createAuthorizationUrl(
      handoffId ? { handoff: handoffId } : {},
    );

    // The verifier must survive the round trip to Discord but never reach the
    // browser's JS; an httpOnly cookie is the smallest thing that does both.
    void reply.setCookie("sq_pkce", codeVerifier, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.NODE_ENV === "production",
      path: "/auth",
      maxAge: 600,
    });
    void reply.setCookie("sq_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.NODE_ENV === "production",
      path: "/auth",
      maxAge: 600,
    });

    return reply.redirect(url);
  });

  const callbackQuery = z.object({
    code: z.string().min(1),
    state: z.string().min(1),
  });

  server.get("/auth/discord/callback", async (req, reply) => {
    const parsed = callbackQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "BAD_CALLBACK", message: "Missing code or state" });
    }

    const cookies = req.cookies as Record<string, string>;
    const expectedState = cookies.sq_state;
    const verifier = cookies.sq_pkce;

    if (!expectedState || !verifier || expectedState !== parsed.data.state) {
      return reply
        .code(400)
        .send({ error: "BAD_STATE", message: "Authorization request did not match" });
    }

    const stateCheck = discord.verifyState(parsed.data.state);
    if (isFail(stateCheck)) {
      return reply.code(400).send({ error: stateCheck.code, message: stateCheck.message });
    }

    const handoffId =
      typeof stateCheck.data.handoff === "string" ? stateCheck.data.handoff : null;

    const login = await auth.completeLogin(parsed.data.code, verifier);
    if (isFail(login)) {
      // Tell the waiting app why, so it stops polling instead of timing out.
      if (handoffId) handoff.reject(handoffId, login.code);
      return reply.code(401).send({ error: login.code, message: login.message });
    }

    void reply.clearCookie("sq_pkce", { path: "/auth" });
    void reply.clearCookie("sq_state", { path: "/auth" });
    void reply.setCookie(SESSION_COOKIE, login.data.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.NODE_ENV === "production",
      path: "/",
      expires: login.data.expiresAt,
    });

    await party.ensureParty(login.data.userId);

    if (handoffId) {
      handoff.fulfill(handoffId, login.data.token);

      // This tab belongs to the browser, not the app; the token must not be
      // rendered into a page the user could copy out of.
      return reply.type("text/html").send(SIGNED_IN_PAGE);
    }

    return reply.send({
      userId: login.data.userId,
      token: login.data.token,
      expiresAt: login.data.expiresAt.toISOString(),
      isNewAccount: login.data.isNewAccount,
    });
  });

  server.post("/auth/logout", { preHandler: authenticate }, async (req, reply) => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const token = bearer ?? (req.cookies as Record<string, string>)[SESSION_COOKIE];

    if (token) await sessions.revoke(token);
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  server.get("/me", { preHandler: authenticate }, async (req) => {
    const user = requireUser(req);
    const partyId = await party.ensureParty(user.userId);
    const profile = await auth.getUser(user.userId);

    const [stats] = await db
      .select({
        rating: playerRatings.rating,
        gamesPlayed: playerRatings.gamesPlayed,
        wins: playerRatings.wins,
        losses: playerRatings.losses,
        peakRating: playerRatings.peakRating,
        queueCooldownUntil: playerRatings.queueCooldownUntil,
        missedAccepts: playerRatings.missedAccepts,
      })
      .from(playerRatings)
      .where(eq(playerRatings.userId, user.userId))
      .limit(1);

    const rating = stats?.rating ?? DEFAULT_RATING;
    const gamesPlayed = stats?.gamesPlayed ?? 0;
    const placed = isPlaced(gamesPlayed);

    return {
      userId: user.userId,
      discordName: user.discordName,
      inGameName: user.inGameName,
      role: user.role,
      rating,
      // Rank stays hidden until placements are done, so early volatility does
      // not read as the ladder being broken.
      tier: placed ? tierForRating(rating) : null,
      placementsRemaining: placementGamesRemaining(gamesPlayed),
      gamesPlayed,
      wins: stats?.wins ?? 0,
      losses: stats?.losses ?? 0,
      peakRating: stats?.peakRating ?? rating,
      party: await party.view(partyId),
      avatarUrl: profile?.avatarUrl ?? null,
      // So a client that reloads mid-cooldown still knows about it, rather
      // than offering a queue button that will be refused.
      queueCooldownSeconds: cooldownRemainingSeconds(stats?.queueCooldownUntil ?? null),
      missedAccepts: stats?.missedAccepts ?? 0,
    };
  });

  server.patch("/me/in-game-name", { preHandler: authenticate }, async (req, reply) => {
    const body = z.object({ name: z.string() }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "INVALID_NAME", message: "Provide a name" });
    }

    const result = await auth.setInGameName(requireUser(req).userId, body.data.name);
    if (isFail(result)) {
      return reply.code(400).send({ error: result.code, message: result.message });
    }
    return result.data;
  });

  // -------------------------------------------------------------------- party

  server.get("/party", { preHandler: authenticate }, async (req) => {
    const partyId = await party.ensureParty(requireUser(req).userId);
    return party.view(partyId);
  });

  server.get("/party/invites", { preHandler: authenticate }, async (req) =>
    party.pendingInvitesFor(requireUser(req).userId),
  );

  /**
   * Everyone else currently connected.
   *
   * Online is a property of the socket table, not the database, so this is the
   * only place that knows it. The whole list is returned and filtered on the
   * client: it is bounded by who is actually connected, and a request per
   * keystroke to re-filter a list we already hold is a worse trade than the
   * payload.
   *
   * Players who cannot be invited are still listed, marked with why. Hiding
   * them would read as "that person is offline" when they are standing right
   * there in someone else's party.
   */
  server.get("/players/online", { preHandler: authenticate }, async (req) => {
    const user = requireUser(req);
    const ids = notifier.onlineUserIds().filter((id) => id !== user.userId);
    if (ids.length === 0) return { players: [] };

    const rows = await db
      .select({
        id: users.id,
        discordName: users.discordName,
        inGameName: users.inGameName,
        rating: playerRatings.rating,
        gamesPlayed: playerRatings.gamesPlayed,
        partySize: sql<number>`(
          SELECT COUNT(*)::int FROM party_members pm2
          WHERE pm2.party_id = (
            SELECT pm3.party_id FROM party_members pm3 WHERE pm3.user_id = ${users.id} LIMIT 1
          )
        )`,
        inMatch: sql<boolean>`EXISTS (
          SELECT 1 FROM match_participants mp
          JOIN matches m ON m.id = mp.match_id
          WHERE mp.user_id = ${users.id}
            AND m.state IN ('PENDING_ACCEPT', 'PARTY_UP', 'LIVE', 'REPORTED')
        )`,
      })
      .from(users)
      .leftJoin(playerRatings, eq(playerRatings.userId, users.id))
      .where(inArray(users.id, ids))
      .orderBy(users.discordName);

    return {
      players: rows.map((r) => {
        const gamesPlayed = r.gamesPlayed ?? 0;
        const unavailable = r.inMatch
          ? "In a match"
          : (r.partySize ?? 1) > 1
            ? "In a party"
            : null;

        return {
          id: r.id,
          discordName: r.discordName,
          inGameName: r.inGameName ?? r.discordName,
          tier: isPlaced(gamesPlayed) ? tierForRating(r.rating ?? DEFAULT_RATING) : null,
          placementsRemaining: placementGamesRemaining(gamesPlayed),
          unavailable,
        };
      }),
    };
  });

  server.post("/party/invite", { preHandler: authenticate }, async (req, reply) => {
    const body = z.object({ userId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "userId is required" });
    }

    const user = requireUser(req);
    const result = await party.invite(user.userId, body.data.userId);
    if (isFail(result)) {
      // Throttling is a "not yet", not a "no" -- worth its own status so the
      // client can show a countdown rather than a rejection.
      const throttled = result.code === "RATE_LIMITED" || result.code === "RECENTLY_INVITED";
      // TARGET_QUEUED is a plain conflict: waiting will not fix it, they have
      // to leave the queue.
      return reply
        .code(throttled ? 429 : 409)
        .send({ error: result.code, message: result.message });
    }

    const [inviter] = await db
      .select({ rating: playerRatings.rating, gamesPlayed: playerRatings.gamesPlayed })
      .from(playerRatings)
      .where(eq(playerRatings.userId, user.userId))
      .limit(1);

    const games = inviter?.gamesPlayed ?? 0;

    notifier.toUser(body.data.userId, {
      type: "party.invite.received",
      invite: {
        inviteId: result.data.inviteId,
        partyId: result.data.partyId,
        fromUserId: user.userId,
        fromName: user.discordName,
        fromTier: isPlaced(games) ? tierForRating(inviter?.rating ?? DEFAULT_RATING) : null,
        // The toast counts down to this, so it has to come from the server.
        expiresAt: new Date(Date.now() + INVITE_EXPIRATION_SECONDS * 1000).toISOString(),
      },
    });

    return result.data;
  });

  server.post("/party/invite/:id/accept", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = requireUser(req);

    const result = await party.accept(user.userId, id);
    if (isFail(result)) {
      return reply.code(409).send({ error: result.code, message: result.message });
    }

    await broadcastParty(result.data.partyId);

    // The party they walked out of has to hear it too, or its remaining members
    // keep a roster with someone in it who has gone.
    if (result.data.leftPartyId) await broadcastParty(result.data.leftPartyId);

    return result.data;
  });

  server.post("/party/invite/:id/decline", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = requireUser(req);

    // Read the inviter before declining: the row is still pending here, and
    // after the update there is nobody obvious left to tell.
    const [invite] = await db
      .select({ fromUserId: partyInvites.fromUserId })
      .from(partyInvites)
      .where(eq(partyInvites.id, id))
      .limit(1);

    const result = await party.decline(user.userId, id);
    if (isFail(result)) {
      return reply.code(404).send({ error: result.code, message: result.message });
    }

    if (invite) {
      notifier.toUser(invite.fromUserId, {
        type: "party.invite.declined",
        inviteId: id,
        byUserId: user.userId,
      });
    }

    return { ok: true };
  });

  server.post("/party/leave", { preHandler: authenticate }, async (req, reply) => {
    const user = requireUser(req);
    const previous = await party.partyIdFor(user.userId);

    const result = await party.leave(user.userId);
    if (isFail(result)) {
      return reply.code(409).send({ error: result.code, message: result.message });
    }

    if (previous) await broadcastParty(previous);
    await broadcastParty(result.data.partyId);
    return result.data;
  });

  server.post("/party/kick", { preHandler: authenticate }, async (req, reply) => {
    const body = z.object({ userId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "userId is required" });
    }

    const result = await party.kick(requireUser(req).userId, body.data.userId);
    if (isFail(result)) {
      return reply.code(409).send({ error: result.code, message: result.message });
    }

    await broadcastParty(result.data.partyId);
    const kickedParty = await party.partyIdFor(body.data.userId);
    if (kickedParty) await broadcastParty(kickedParty);

    return result.data;
  });

  /**
   * Whether anyone in the party is barred from queueing, and why.
   *
   * Covers both a missed-accept cooldown and a moderator ban. The ban was
   * already stored and never checked, so it did not actually stop anyone.
   */
  async function blockedFromQueue(
    partyId: string,
  ): Promise<{ error: string; message: string; secondsRemaining: number } | null> {
    const rows = await db
      .select({
        discordName: users.discordName,
        bannedUntil: users.bannedUntil,
        cooldownUntil: playerRatings.queueCooldownUntil,
      })
      .from(partyMembers)
      .innerJoin(users, eq(users.id, partyMembers.userId))
      .leftJoin(playerRatings, eq(playerRatings.userId, partyMembers.userId))
      .where(eq(partyMembers.partyId, partyId));

    const solo = rows.length === 1;

    for (const row of rows) {
      const banned = cooldownRemainingSeconds(row.bannedUntil ?? null);
      if (banned > 0) {
        return {
          error: "BANNED",
          message: solo
            ? "Your account is suspended."
            : row.discordName + "'s account is suspended.",
          secondsRemaining: banned,
        };
      }

      const cooling = cooldownRemainingSeconds(row.cooldownUntil ?? null);
      if (cooling > 0) {
        return {
          error: "QUEUE_COOLDOWN",
          message: solo
            ? "You missed a match you accepted into. The queue reopens shortly."
            : row.discordName + " is on a queue cooldown.",
          secondsRemaining: cooling,
        };
      }
    }

    return null;
  }

  async function broadcastParty(partyId: string): Promise<void> {
    const view = await party.view(partyId);
    if (!view) return;
    notifier.toUsers(
      view.members.map((m) => m.userId),
      { type: "party.updated", party: view },
    );
  }

  // -------------------------------------------------------------------- queue

  const joinBody = z.object({
    regions: z.array(z.enum(REGIONS)).min(1, "Pick at least one region"),
  });

  server.post("/queue/join", { preHandler: authenticate }, async (req, reply) => {
    const body = joinBody.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "BAD_REQUEST", message: body.error.issues[0]?.message });
    }

    const user = requireUser(req);
    const partyId = await party.ensureParty(user.userId);

    const [{ leaderId }] = [await party.view(partyId)].map((v) => ({
      leaderId: v?.leaderId ?? user.userId,
    }));
    if (leaderId !== user.userId) {
      return reply
        .code(403)
        .send({ error: "NOT_LEADER", message: "Only the party leader can queue" });
    }

    const size = await party.memberCount(partyId);
    if (size > MAX_PARTY_SIZE) {
      return reply.code(409).send({ error: "PARTY_FULL", message: "Party is too large" });
    }

    // One member on a cooldown blocks the party. Letting the rest queue without
    // them would turn a penalty into "ask a friend to carry you past it", and
    // silently dropping them from the party is not ours to do.
    const blocked = await blockedFromQueue(partyId);
    if (blocked) return reply.code(403).send(blocked);

    const rating = await party.averageRating(partyId, DEFAULT_RATING);
    const ticket = await queue.join({
      partyId,
      regions: body.data.regions,
      ratingSnapshot: rating,
      size,
    });

    if (!ticket) {
      return reply.code(409).send({ error: "ALREADY_QUEUED", message: "Already in the queue" });
    }

    const members = await party.memberIds([partyId]);
    notifier.toUsers(members, {
      type: "queue.joined",
      partyId,
      regions: body.data.regions,
      joinedAt: Date.now(),
    });

    // A new ticket may complete a match immediately; do not wait for the tick.
    matchmaker.requestRun();

    return { partyId, regions: body.data.regions, size, rating };
  });

  server.post("/queue/leave", { preHandler: authenticate }, async (req, reply) => {
    const user = requireUser(req);
    // ensureParty rather than partyIdFor: whether the party row happens to
    // exist yet is an internal detail, and the caller asked about the queue.
    const partyId = await party.ensureParty(user.userId);

    const left = await queue.leave(partyId);
    if (!left) {
      return reply.code(409).send({ error: "NOT_QUEUED", message: "Not in the queue" });
    }

    const members = await party.memberIds([partyId]);
    notifier.toUsers(members, { type: "queue.left", partyId });

    return { ok: true };
  });

  server.get("/queue/stats", async () => ({
    online: notifier.onlineCount(),
    inQueue: await queue.countQueuedPlayers(),
    inMatch: await lifecycle.countPlayersInMatches(),
  }));

  // -------------------------------------------------------------------- teams

  /**
   * Two prefixes on purpose: `/teams` is the directory anyone browses, `/team`
   * is the one you are on. Almost every action applies to your own team and
   * carries no id, which keeps "may I touch this team" from being a question
   * each route has to ask for itself.
   */
  const teamErrorStatus = (code: string): number => {
    if (code === "TEAM_NOT_FOUND" || code === "APPLICATION_NOT_FOUND") return 404;
    if (code === "NOT_CAPTAIN" || code === "NOT_A_MANAGER") return 403;
    if (code.startsWith("INVALID_")) return 400;
    return 409;
  };

  async function broadcastTeam(teamId: string): Promise<void> {
    const view = await team.view(teamId);
    if (!view) return;
    notifier.toUsers(
      view.members.map((m) => m.userId),
      { type: "team.updated", team: view },
    );
  }

  server.get("/teams", { preHandler: authenticate }, async (req) => {
    const { region } = req.query as { region?: string };
    return { teams: await team.list(region) };
  });

  server.get("/teams/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = await team.view(id);
    if (!view) return reply.code(404).send({ error: "TEAM_NOT_FOUND", message: "No such team" });
    return view;
  });

  /** Your team, plus the parts of it only you can see. */
  server.get("/me/team", { preHandler: authenticate }, async (req) => {
    const user = requireUser(req);
    const teamId = await team.teamIdFor(user.userId);

    if (!teamId) {
      return {
        team: null,
        role: null,
        applications: [],
        myApplication: await team.myApplication(user.userId),
      };
    }

    const view = await team.view(teamId);
    const role = view?.members.find((m) => m.userId === user.userId)?.role ?? null;
    const manages = role === "captain" || role === "officer";

    return {
      team: view,
      role,
      // Applications are the managers' business, not the whole roster's.
      applications: manages ? await team.pendingApplications(teamId) : [],
      myApplication: null,
    };
  });

  server.post("/teams", { preHandler: authenticate }, async (req, reply) => {
    const body = z
      .object({ tag: z.string(), name: z.string(), region: z.string() })
      .safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "BAD_REQUEST", message: "tag, name and region are required" });
    }

    const result = await team.create(requireUser(req).userId, body.data);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    await broadcastTeam(result.data.teamId);
    return result.data;
  });

  server.post("/teams/:id/apply", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ note: z.string().max(TEAM_APPLICATION_NOTE_MAX_LENGTH).nullish() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "That note is too long" });
    }

    const result = await team.apply(requireUser(req).userId, id, body.data.note ?? null);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    // Managers hear about it, so a waiting application does not need a refresh
    // to show up.
    const view = await team.view(id);
    const managers = (view?.members ?? [])
      .filter((m) => m.role === "captain" || m.role === "officer")
      .map((m) => m.userId);
    notifier.toUsers(managers, { type: "team.application.received", teamId: id });

    return result.data;
  });

  server.post("/me/application/withdraw", { preHandler: authenticate }, async (req, reply) => {
    const result = await team.withdrawApplication(requireUser(req).userId);
    if (isFail(result)) {
      return reply.code(404).send({ error: result.code, message: result.message });
    }
    return { ok: true };
  });

  server.post("/team/applications/:id/decide", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ accept: z.boolean() }).safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "BAD_REQUEST", message: "accept must be true or false" });
    }

    const result = await team.decideApplication(requireUser(req).userId, id, body.data.accept);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    await broadcastTeam(result.data.teamId);
    // The applicant hears either way; a denial would otherwise be silence.
    notifier.toUser(result.data.userId, {
      type: "team.application.decided",
      teamId: result.data.teamId,
      accepted: result.data.joined,
    });

    return result.data;
  });

  server.patch("/team/applications-open", { preHandler: authenticate }, async (req, reply) => {
    const body = z.object({ open: z.boolean() }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "open must be true or false" });
    }

    const user = requireUser(req);
    const teamId = await team.teamIdFor(user.userId);
    if (!teamId) {
      return reply.code(409).send({ error: "NOT_IN_TEAM", message: "You are not in a team" });
    }

    const result = await team.setApplicationsOpen(user.userId, teamId, body.data.open);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    await broadcastTeam(teamId);
    return { ok: true };
  });

  server.post("/team/members/:userId/role", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = z.object({ role: z.enum(["officer", "member"]) }).safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "BAD_REQUEST", message: "role must be officer or member" });
    }

    const result = await team.setRole(requireUser(req).userId, userId, body.data.role);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    await broadcastTeam(result.data.teamId);
    return { ok: true };
  });

  server.post("/team/captain", { preHandler: authenticate }, async (req, reply) => {
    const body = z.object({ userId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "userId is required" });
    }

    const result = await team.transferCaptaincy(requireUser(req).userId, body.data.userId);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    await broadcastTeam(result.data.teamId);
    return { ok: true };
  });

  server.delete("/team/members/:userId", { preHandler: authenticate }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const result = await team.removeMember(requireUser(req).userId, userId);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    await broadcastTeam(result.data.teamId);
    notifier.toUser(userId, { type: "team.removed", teamId: result.data.teamId });
    return { ok: true };
  });

  server.post("/team/leave", { preHandler: authenticate }, async (req, reply) => {
    const result = await team.leave(requireUser(req).userId);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    if (!result.data.disbanded) await broadcastTeam(result.data.teamId);
    return result.data;
  });

  server.delete("/team", { preHandler: authenticate }, async (req, reply) => {
    const result = await team.disband(requireUser(req).userId);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    // The team is gone, so there is no view left to broadcast.
    notifier.toUsers(result.data.memberIds, {
      type: "team.disbanded",
      teamId: result.data.teamId,
    });
    return { ok: true };
  });

  // -------------------------------------------------------------------- match

  server.post("/match/:id/accept", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = requireUser(req);

    const result = await lifecycle.accept(id, user.userId);
    if (isFail(result)) {
      return reply.code(409).send({ error: result.code, message: result.message });
    }

    const parts = await lifecycle.participants(id);
    const userIds = parts.map((p) => p.userId);

    notifier.toUsers(userIds, {
      type: "match.accept.progress",
      matchId: id,
      accepted: result.data.accepted,
      total: parts.length,
    });

    if (result.data.allAccepted) {
      notifier.toUsers(userIds, { type: "match.state", matchId: id, state: "PARTY_UP" });
    }

    return result.data;
  });

  server.post("/match/:id/decline", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = requireUser(req);

    const parts = await lifecycle.participants(id);
    const result = await lifecycle.decline(id, user.userId);
    if (isFail(result)) {
      return reply.code(409).send({ error: result.code, message: result.message });
    }

    for (const p of parts) {
      notifier.toUser(p.userId, {
        type: "match.cancelled",
        matchId: id,
        reason: "DECLINED",
        atFault: p.userId === user.userId,
        cooldownSeconds: p.userId === user.userId ? result.data.cooldownSeconds : 0,
      });
    }

    return result.data;
  });

  const reportBody = z.object({ winner: z.enum(["TEAM1", "TEAM2"]) });

  server.post("/match/:id/report", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = reportBody.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "BAD_REQUEST", message: "winner must be TEAM1 or TEAM2" });
    }

    const user = requireUser(req);
    const result = await reporting.report(id, user.userId, body.data.winner);
    if (isFail(result)) {
      const status = result.code === "NOT_A_CAPTAIN" ? 403 : 409;
      return reply.code(status).send({ error: result.code, message: result.message });
    }

    const parts = await lifecycle.participants(id);
    const userIds = parts.map((p) => p.userId);

    if (result.data.state === "REPORTED") {
      notifier.toUsers(userIds, { type: "match.state", matchId: id, state: "REPORTED" });
    } else if (result.data.state === "DISPUTED") {
      notifier.toUsers(userIds, { type: "match.state", matchId: id, state: "DISPUTED" });
    } else {
      // Each player is told their own outcome, not the whole table, and in
      // ranks rather than points.
      for (const change of result.data.ratingChanges ?? []) {
        notifier.toUser(change.userId, {
          type: "match.resolved",
          matchId: id,
          result: result.data.winner ?? "",
          tierBefore: change.tierBefore,
          tierAfter: change.tierAfter,
          placementsRemaining: change.placementsRemaining,
        });
      }
    }

    return result.data;
  });

  server.get("/match/:id/reports", { preHandler: authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    return reporting.reportsFor(id);
  });

  server.get("/me/history", { preHandler: authenticate }, async (req) => {
    const limit = Number((req.query as Record<string, string>)?.limit ?? 25);
    return reporting.historyFor(requireUser(req).userId, Math.min(Math.max(limit, 1), 100));
  });

  // ------------------------------------------------------------- moderation

  function requireModerator(req: FastifyRequest, reply: FastifyReply): boolean {
    const user = requireUser(req);
    if (user.role === "player") {
      void reply.code(403).send({ error: "FORBIDDEN", message: "Moderator access required" });
      return false;
    }
    return true;
  }

  server.get("/mod/disputes", { preHandler: authenticate }, async (req, reply) => {
    if (!requireModerator(req, reply)) return reply;
    return reporting.openDisputes();
  });

  const rulingBody = z.object({
    winner: z.enum(["TEAM1", "TEAM2"]),
    note: z.string().min(1).max(500),
  });

  server.post("/mod/disputes/:id/resolve", { preHandler: authenticate }, async (req, reply) => {
    if (!requireModerator(req, reply)) return reply;

    const { id } = req.params as { id: string };
    const body = rulingBody.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "BAD_REQUEST", message: "winner and a note are required" });
    }

    const user = requireUser(req);
    const result = await reporting.resolveDispute(id, user.userId, body.data.winner, body.data.note);
    if (isFail(result)) {
      return reply.code(409).send({ error: result.code, message: result.message });
    }

    for (const change of result.data.ratingChanges ?? []) {
      notifier.toUser(change.userId, {
        type: "match.resolved",
        matchId: id,
        result: result.data.winner ?? "",
        tierBefore: change.tierBefore,
        tierAfter: change.tierAfter,
        placementsRemaining: change.placementsRemaining,
      });
    }

    return result.data;
  });

  server.get("/match/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const view = await lifecycle.view(id);
    if (!view) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "Match not found" });
    }

    const user = requireUser(req);
    const inMatch = [...view.team1, ...view.team2].some((p) => p.id === user.userId);
    if (!inMatch && user.role === "player") {
      return reply.code(403).send({ error: "FORBIDDEN", message: "Not your match" });
    }

    return view;
  });

  // ---------------------------------------------------------------- websocket

  /**
   * Players whose socket has dropped but whose seat is still being held.
   *
   * A dropped socket is usually a blip and the client reconnects on its own, so
   * a party is not disbanded the instant one goes quiet. If they are still gone
   * when the timer fires, they are taken out of the party -- otherwise a closed
   * app occupies a slot in a five-stack forever, and the leader has to notice
   * and kick a ghost.
   */
  const disconnectTimers = new Map<string, NodeJS.Timeout>();

  // Fires only when the last of a user's connections has gone: two windows
  // open means closing one is not a disconnect.
  notifier.onUserOffline = (userId) => scheduleDisconnectCheck(userId);

  async function dropFromPartyIfStillGone(userId: string): Promise<void> {
    disconnectTimers.delete(userId);
    if (notifier.isOnline(userId)) return;

    const partyId = await party.partyIdFor(userId);
    if (!partyId) return;
    if ((await party.memberCount(partyId)) <= 1) return; // A solo party is theirs to keep.

    const result = await party.leave(userId);
    if (isFail(result)) return;

    // The party they left needs to hear about it; the fresh solo party they
    // landed in has nobody else in it to tell.
    await broadcastParty(partyId);
  }

  function scheduleDisconnectCheck(userId: string): void {
    clearTimeout(disconnectTimers.get(userId));
    const timer = setTimeout(() => {
      void dropFromPartyIfStillGone(userId).catch((err) =>
        server.log.error({ err, userId }, "disconnect cleanup failed"),
      );
    }, partyDisconnectGraceMs);

    // Never hold the process open for a timer whose only job is tidying up.
    timer.unref?.();
    disconnectTimers.set(userId, timer);
  }

  server.addHook("onClose", async () => {
    for (const timer of disconnectTimers.values()) clearTimeout(timer);
    disconnectTimers.clear();
  });

  server.get("/ws", { websocket: true }, async (socket, req) => {
    const token =
      (req.query as Record<string, string>)?.token ??
      (req.cookies as Record<string, string>)?.[SESSION_COOKIE];

    const session = await sessions.verify(token ?? "");
    if (isFail(session)) {
      socket.close(4401, "unauthorized");
      return;
    }

    const userId = session.data.userId;
    const conn = {
      send: (payload: string) => socket.send(payload),
      close: () => socket.close(),
    };

    notifier.add(userId, conn);
    // They are back, so whatever was counting down for them can stop.
    clearTimeout(disconnectTimers.get(userId));
    disconnectTimers.delete(userId);

    socket.on("message", (raw: Buffer) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(raw.toString()) as { type?: string };
      } catch {
        return;
      }

      // Heartbeat is the queue's liveness signal: a ticket whose client stops
      // sending these is pruned, so a closed app does not hold a queue slot.
      if (msg.type === "heartbeat") {
        void party.partyIdFor(userId).then((partyId) => {
          if (partyId) void queue.heartbeat(partyId, userId);
        });
      }
    });

    socket.on("close", () => notifier.remove(userId, conn));
    socket.on("error", () => notifier.remove(userId, conn));
  });

  if (autoStart) {
    matchmaker.start();
    sweeper.start();
  }

  server.addHook("onClose", async () => {
    matchmaker.stop();
    sweeper.stop();
    notifier.closeAll();
  });

  return {
    server,
    notifier,
    matchmaker,
    sweeper,
    services: { auth, sessions, party, queue, lifecycle, reporting, team },
  };
}
