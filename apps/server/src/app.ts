import {
  gameConfig,
  DEFAULT_RATING,
  WRITE_RATE_LIMIT,
  WRITE_RATE_WINDOW_SECONDS,
  INVITE_EXPIRATION_SECONDS,
  MAX_PARTY_SIZE,
  PARTY_DISCONNECT_GRACE_SECONDS,
  TEAM_APPLICATION_NOTE_MAX_LENGTH,
  TEAM_NOTE_MAX_LENGTH,
  cooldownRemainingSeconds,
  REGIONS,
  isFail,
  isPlaced,
  meetsMinimum,
  placementGamesRemaining,
  tierForRating,
} from "@suddenqueue/core";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { eq, inArray, sql } from "drizzle-orm";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";

import { AuthService } from "./auth/service.js";
import { DiscordAuth } from "./auth/discord.js";
import { LoginHandoff } from "./auth/handoff.js";
import { SessionService, type SessionUser } from "./auth/sessions.js";
import { isGameMaster } from "./auth/roles.js";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { partyInvites, partyMembers, playerRatings, users } from "./db/schema/index.js";
import { MatchLifecycle } from "./match/lifecycle.js";
import { MatchReporting } from "./match/reporting.js";
import { Matchmaker, MatchSweeper } from "./matchmaker/loop.js";
import { PartyService } from "./party/service.js";
import { TeamService } from "./team/service.js";
import { ScrimService } from "./scrim/service.js";
import { LadderService } from "./ladder/service.js";
import { ChatService } from "./chat/service.js";
import { ModerationService, MAX_SUSPENSION_HOURS, MIN_SUSPENSION_HOURS, SUSPENSION_REASON_MAX_LENGTH } from "./moderation/service.js";
import { RateLimiter } from "./http/rate-limit.js";
import { QueueRepository } from "./queue/repository.js";
import { createReleaseFloor } from "./releases.js";
import { Notifier } from "./realtime/notifier.js";
import { Population } from "./realtime/population.js";

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
  population: Population;
  matchmaker: Matchmaker;
  sweeper: MatchSweeper;
  /** Exposed so tests can expire a lineup window without waiting it out. */
  sweepScrims: () => Promise<void>;
  services: {
    auth: AuthService;
    sessions: SessionService;
    party: PartyService;
    queue: QueueRepository;
    lifecycle: MatchLifecycle;
    reporting: MatchReporting;
    moderation: ModerationService;
    team: TeamService;
    scrim: ScrimService;
    ladder: LadderService;
    chat: ChatService;
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

  /**
   * The last word on anything that escaped a route.
   *
   * Fastify's default replies with the thrown error's own message, which for a
   * database failure is a Postgres sentence naming constraints, columns, and
   * sometimes a fragment of the query. That is a map of the schema handed to
   * anyone who can provoke a 500.
   *
   * So the full error is logged, and the client is told only that something
   * broke. Deliberate refusals are unaffected: those are `reply.code(...)`
   * calls that return normally and never reach here. Anything that does reach
   * here is a bug, and a bug is not something to explain to a stranger.
   */
  server.setErrorHandler((error: FastifyError, req, reply) => {
    const status = error.statusCode ?? 500;

    if (status >= 500) {
      req.log.error({ err: error, url: req.url, method: req.method }, "unhandled route error");
      return reply.code(500).send({
        error: "INTERNAL",
        message: "Something went wrong on our end. Try again in a moment.",
      });
    }

    // Below 500 the message was written for a person: a malformed body, an
    // unsupported content type. Those say what to fix, so they are kept.
    return reply.code(status).send({
      error: error.code ?? "BAD_REQUEST",
      message: error.message,
    });
  });

  /**
   * Refuse clients older than the version this deployment serves.
   *
   * The client already refuses to open on an old version, but that is the
   * client's own promise to keep, and a promise kept only by the software it
   * constrains is not enforcement: a binary that never restarts, or one whose
   * update endpoint has been pointed at nothing, never sees the gate. This is
   * the half that does not depend on the client cooperating.
   *
   * The floor is whatever `latest.json` names, so publishing a release is what
   * raises it -- there is no separate setting to forget.
   */
  const releases = createReleaseFloor(config.SQ_RELEASES_DIR, {
    // Said out loud, because the symptom of a bad publish is that nothing
    // happens: the floor stays where it was and the release nobody can install
    // is also the release nobody is being refused for. A silent no-op is the
    // right behaviour and the wrong thing to leave undiagnosable.
    onProblem: (problem) => server.log.warn({ problem }, "not raising the client version floor"),
  });

  /**
   * What answers regardless of version.
   *
   * `/health` because a monitor is not a client. `/config` because a refused
   * client still has to render, and what it renders is this deployment's name.
   * The two Discord routes because the browser follows them during sign-in,
   * and a browser is not a client either -- gating those would break the
   * callback and the failure would look like a Discord problem.
   */
  const VERSION_EXEMPT = new Set([
    "/health",
    "/config",
    "/auth/discord/start",
    "/auth/discord/callback",
  ]);

  server.addHook("onRequest", async (req, reply) => {
    // Registered after CORS on purpose, so the refusal carries the headers a
    // browser needs in order to be allowed to read it.
    if (req.method === "OPTIONS") return;

    const minimum = releases.current();
    if (!minimum) return;

    if (VERSION_EXEMPT.has(req.url.split("?")[0])) return;

    // A header for ordinary requests, the query string for the websocket:
    // nothing lets script set headers on a WebSocket handshake, so the one
    // request that cannot carry the header says it in the URL instead.
    const header = req.headers["x-client-version"];
    const sent =
      (Array.isArray(header) ? header[0] : header) ??
      (req.query as Record<string, string> | undefined)?.v;

    if (meetsMinimum(sent, minimum)) return;

    return reply.code(426).send({
      error: "CLIENT_TOO_OLD",
      message: `This copy of the app is out of date. Version ${minimum} is required to play.`,
      // Named separately as well as in the sentence: the client puts it on
      // screen, and parsing it back out of prose would break the first time
      // this message is translated.
      minimum,
    });
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
  const scrim = new ScrimService(db);
  const ladder = new LadderService(db);
  const chat = new ChatService();
  const queue = new QueueRepository(db);
  const lifecycle = new MatchLifecycle(db);
  const reporting = new MatchReporting(db);
  const moderation = new ModerationService(db);

  // ---------------------------------------------------------------- realtime

  /**
   * The header counters, pushed rather than polled.
   *
   * Every site below that moves one of these numbers nudges it. Missing one is
   * a wrong number for a sweep interval, not forever -- see Population.
   */
  const population = new Population(
    notifier,
    async () => ({
      online: notifier.onlineCount(),
      inQueue: await queue.countQueuedPlayers(),
      inMatch: await lifecycle.countPlayersInMatches(),
    }),
    { onError: (err) => server.log.error({ err }, "population refresh failed") },
  );

  const matchmaker = new Matchmaker(queue, lifecycle, {
    onMatchCreated: async (match) => {
      const detail = await lifecycle.view(match.matchId);
      notifier.toUsers(match.userIds, {
        type: "match.found",
        matchId: match.matchId,
        acceptDeadline: match.acceptDeadline.toISOString(),
        match: detail,
      });
      population.nudge();
    },
    onTicketsPruned: async (partyIds) => {
      const userIds = await party.memberIds(partyIds);
      notifier.toUsers(userIds, {
        type: "queue.left",
        partyId: partyIds[0] ?? "",
        reason: "CONNECTION_LOST",
      });
      population.nudge();
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
      chat.clearMatch(matchId);
      notifier.toUsers(kept, {
        type: "match.cancelled",
        matchId,
        reason: "ACCEPT_TIMEOUT",
        atFault: false,
        cooldownSeconds: 0,
      });
      population.nudge();
    },
    onLive: async (matchId) => {
      const parts = await lifecycle.participants(matchId);
      notifier.toUsers(
        parts.map((p) => p.userId),
        { type: "match.state", matchId, state: "LIVE" },
      );
      population.nudge();
    },
    onDisputed: async (matchId) => {
      const parts = await lifecycle.participants(matchId);
      notifier.toUsers(
        parts.map((p) => p.userId),
        { type: "match.state", matchId, state: "DISPUTED" },
      );
      population.nudge();
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

  /**
   * A ceiling on writes, per account.
   *
   * Chat and invites police themselves at rates suited to what they cost; this
   * covers the rest -- teams, applications, scrim listings and requests. It
   * runs after authenticate, so the key is an account rather than an address:
   * an address is shared by everyone behind a household router, and a limit
   * that punishes a flatmate is worse than none.
   */
  const writes = new RateLimiter(WRITE_RATE_LIMIT, WRITE_RATE_WINDOW_SECONDS);

  const writePruner = setInterval(() => writes.prune(), 5 * 60_000);
  writePruner.unref?.();

  async function throttleWrites(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = req.user;
    if (!user) return; // authenticate has already refused this request.

    const verdict = writes.take(user.userId);
    if (!verdict.ok) {
      await reply
        .code(429)
        .header("retry-after", String(verdict.retryAfterSeconds))
        .send({
          error: "RATE_LIMITED",
          message: `Slow down a moment — try again in ${verdict.retryAfterSeconds}s`,
          secondsRemaining: verdict.retryAfterSeconds,
        });
    }
  }

  /** authenticate, then the write ceiling. Order matters: the key is the account. */
  const authedWrite = [authenticate, throttleWrites];

  function requireUser(req: FastifyRequest): SessionUser {
    if (!req.user) throw new Error("route is missing the auth preHandler");
    return req.user;
  }

  // ------------------------------------------------------------------ routes

  server.get("/health", async () => ({ ok: true }));

  /**
   * What this deployment is.
   *
   * Unauthenticated on purpose: the client needs the name to put on the
   * sign-in screen before anyone has signed in. Nothing here is a secret --
   * it is the shape of the game, which every player can see anyway.
   *
   * A shipped desktop binary cannot read the server's environment, so this is
   * how it learns whether it is running a 5v5 or a 3v3, what the ranks are
   * called, and which regions exist. The client compiles in none of it.
   */
  server.get("/config", async () => gameConfig);

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
      isGameMaster: isGameMaster(user.role),
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
        avatarUrl: users.avatarUrl,
        inGameName: users.inGameName,
        role: users.role,
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
          // Selected from the start and then dropped here, which is why the
          // invite list drew initials for people who have a picture.
          avatarUrl: r.avatarUrl,
          isGameMaster: isGameMaster(r.role),
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
        // The name the invitee will recognise, which is the one they would see
        // in a game rather than the one on a Discord account.
        fromName: user.inGameName ?? user.discordName,
        fromAvatarUrl: user.avatarUrl,
        fromIsGameMaster: isGameMaster(user.role),
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
   * Covers both a missed-accept cooldown and a Game Master ban. The ban was
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

  /**
   * Regions are configured per deployment, so this validates against the list
   * rather than compiling one in. z.enum needs a literal tuple, which a
   * configured list can never be.
   */
  const regionSchema = z
    .string()
    .refine((r) => REGIONS.includes(r), { message: "Unknown region" });

  const joinBody = z.object({
    regions: z.array(regionSchema).min(1, "Pick at least one region"),
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

    population.nudge();
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
    population.nudge();

    return { ok: true };
  });

  /**
   * The same three numbers the socket pushes.
   *
   * Nothing polls this any more -- the client learns the counts on connect and
   * hears about every change. It stays because a number worth showing is worth
   * being able to ask for, and it is the one place that reads them without a
   * socket.
   */
  server.get("/queue/stats", async () => population.current());

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

  server.post("/teams", { preHandler: authedWrite }, async (req, reply) => {
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

  server.post("/teams/:id/apply", { preHandler: authedWrite }, async (req, reply) => {
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

  server.post("/team/applications/:id/decide", { preHandler: authedWrite }, async (req, reply) => {
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

  /**
   * What the team says about itself in the directory.
   *
   * Managers rather than the captain alone: this is recruiting copy, and the
   * officer fielding the applications is the one who knows what it should say.
   */
  server.patch("/team/note", { preHandler: authedWrite }, async (req, reply) => {
    const body = z
      .object({ note: z.string().max(TEAM_NOTE_MAX_LENGTH).nullable() })
      .safeParse(req.body);

    if (!body.success) {
      return reply.code(400).send({
        error: "BAD_REQUEST",
        message: `note must be text of at most ${TEAM_NOTE_MAX_LENGTH} characters, or null`,
      });
    }

    const user = requireUser(req);
    const teamId = await team.teamIdFor(user.userId);
    if (!teamId) {
      return reply.code(409).send({ error: "NOT_IN_TEAM", message: "You are not in a team" });
    }

    const result = await team.setNote(user.userId, teamId, body.data.note);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    await broadcastTeam(teamId);
    return { ok: true };
  });

  server.patch("/team/applications-open", { preHandler: authedWrite }, async (req, reply) => {
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

  server.post("/team/members/:userId/role", { preHandler: authedWrite }, async (req, reply) => {
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

  server.post("/team/members/:userId/starter", { preHandler: authedWrite }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = z.object({ starting: z.boolean() }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "starting must be true or false" });
    }

    const result = await team.setStarter(requireUser(req).userId, userId, body.data.starting);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    await broadcastTeam(result.data.teamId);
    return { ok: true };
  });

  server.post("/team/captain", { preHandler: authedWrite }, async (req, reply) => {
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

  server.delete("/team/members/:userId", { preHandler: authedWrite }, async (req, reply) => {
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

  server.post("/team/leave", { preHandler: authedWrite }, async (req, reply) => {
    const result = await team.leave(requireUser(req).userId);
    if (isFail(result)) {
      return reply
        .code(teamErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    if (!result.data.disbanded) await broadcastTeam(result.data.teamId);
    return result.data;
  });

  server.delete("/team", { preHandler: authedWrite }, async (req, reply) => {
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

  // ------------------------------------------------------------------ scrims

  const scrimErrorStatus = (code: string): number => {
    if (code === "LISTING_NOT_FOUND" || code === "REQUEST_NOT_FOUND") return 404;
    if (code === "NOT_A_MANAGER" || code === "NOT_IN_TEAM" || code === "NOT_CAPTAIN") return 403;
    if (code === "INVALID_REGION") return 400;
    // CAPTAIN_OFFLINE and NOT_ENOUGH_ONLINE fall through to 409: nothing is
    // wrong with the request, the team simply is not there yet.
    return 409;
  };

  /** Everything the scrims screen needs, from whichever side you are on. */
  /**
   * Turns a settled arrangement into a match.
   *
   * Reached either straight from acceptance -- when both rosters are exactly
   * five and there was nothing to choose -- or from the second captain
   * confirming. Either way the ten names are settled before this runs.
   */
  async function commitScrim(input: {
    requestId: string;
    listingId: string;
    region: string;
    hostTeamId: string;
    guestTeamId: string;
  }): Promise<{ ok: true; matchId: string } | { ok: false; code: string; message: string }> {
    const lineups = await scrim.lineupsFor(input.requestId);
    if (!lineups) return { ok: false, code: "NOT_CONFIRMING", message: "A lineup is still missing" };

    const host = await scrim.lineup(input.hostTeamId, lineups.host);
    const guest = await scrim.lineup(input.guestTeamId, lineups.guest);

    if (!host || !guest) {
      await scrim.reopen(input.listingId, input.requestId);
      return { ok: false, code: "ROSTER_TOO_SMALL", message: "One of the rosters is short of five" };
    }

    const committed = await lifecycle.createScrim({
      region: input.region,
      team1Id: input.hostTeamId,
      team2Id: input.guestTeamId,
      team1UserIds: host.userIds,
      team2UserIds: guest.userIds,
      captain1: host.captainId,
      captain2: guest.captainId,
      team1Rating: host.rating,
      team2Rating: guest.rating,
    });
    population.nudge();

    if (isFail(committed)) {
      await scrim.reopen(input.listingId, input.requestId);
      return { ok: false, code: committed.code, message: committed.message };
    }

    await scrim.markMatched(input.listingId);

    const view = await lifecycle.view(committed.data.matchId);
    notifier.toUsers(committed.data.userIds, {
      type: "match.found",
      matchId: committed.data.matchId,
      acceptDeadline: committed.data.acceptDeadline.toISOString(),
      match: view,
    });

    return { ok: true, matchId: committed.data.matchId };
  }

  server.get("/scrims", { preHandler: authenticate }, async (req) => {
    const user = requireUser(req);
    const { region } = req.query as { region?: string };
    const teamId = await team.teamIdFor(user.userId);

    return {
      listings: await scrim.openListings(teamId, region),
      myListing: teamId ? await scrim.listingFor(teamId) : null,
      incoming: teamId ? await scrim.incomingRequests(teamId) : [],
      // Null unless this reader is a captain whose team still owes a five.
      pendingLineup: await scrim.pendingLineupFor(user.userId),
    };
  });

  server.post("/scrims", { preHandler: authedWrite }, async (req, reply) => {
    const body = z
      .object({ region: z.string(), note: z.string().max(200).nullish() })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "region is required" });
    }

    const result = await scrim.postListing(
      requireUser(req).userId,
      { region: body.data.region, note: body.data.note ?? null },
      new Set(notifier.onlineUserIds()),
    );
    if (isFail(result)) {
      return reply
        .code(scrimErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    return result.data;
  });

  server.delete("/scrims/mine", { preHandler: authedWrite }, async (req, reply) => {
    const result = await scrim.removeListing(requireUser(req).userId);
    if (isFail(result)) {
      return reply
        .code(scrimErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }
    return { ok: true };
  });

  server.post("/scrims/:id/request", { preHandler: authedWrite }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await scrim.request(requireUser(req).userId, id, new Set(notifier.onlineUserIds()));
    if (isFail(result)) {
      return reply
        .code(scrimErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    // The host's managers hear it without refreshing.
    const host = await team.view(result.data.hostTeamId);
    notifier.toUsers(
      (host?.members ?? [])
        .filter((m) => m.role === "captain" || m.role === "officer")
        .map((m) => m.userId),
      { type: "scrim.request.received", listingId: id },
    );

    return result.data;
  });

  server.post("/scrims/requests/:id/withdraw", { preHandler: authedWrite }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await scrim.withdrawRequest(requireUser(req).userId, id);
    if (isFail(result)) {
      return reply
        .code(scrimErrorStatus(result.code))
        .send({ error: result.code, message: result.message });
    }
    return { ok: true };
  });

  /**
   * Accepting is the point where a scrim stops being an arrangement and becomes
   * a match, so it does the same thing the matchmaker does: names ten players
   * and commits them. If that commit fails -- someone is already in a match, or
   * sitting in the PUG queue -- the request goes back to pending rather than
   * being quietly consumed.
   */
  server.post("/scrims/requests/:id/decide", { preHandler: authedWrite }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ accept: z.boolean() }).safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "BAD_REQUEST", message: "accept must be true or false" });
    }

    const decided = await scrim.decideRequest(
      requireUser(req).userId,
      id,
      body.data.accept,
      new Set(notifier.onlineUserIds()),
    );
    if (isFail(decided)) {
      return reply
        .code(scrimErrorStatus(decided.code))
        .send({ error: decided.code, message: decided.message });
    }

    if (!decided.data.accepted) {
      notifier.toUsers(await team.memberIds(decided.data.guestTeamId), {
        type: "scrim.request.decided",
        listingId: decided.data.listingId,
        accepted: false,
      });
      return { accepted: false };
    }

    // A team carrying substitutes has to say who plays before anyone is
    // asked to accept. Both captains are told; whoever is last to confirm
    // triggers the match.
    if (!decided.data.ready) {
      for (const teamId of [decided.data.hostTeamId, decided.data.guestTeamId]) {
        notifier.toUsers(await team.memberIds(teamId), {
          type: "scrim.lineup.required",
          requestId: id,
        });
      }
      return { accepted: true, awaitingLineup: true };
    }

    const result = await commitScrim({
      requestId: id,
      listingId: decided.data.listingId,
      region: decided.data.region,
      hostTeamId: decided.data.hostTeamId,
      guestTeamId: decided.data.guestTeamId,
    });

    if (!result.ok) {
      return reply.code(409).send({ error: result.code, message: result.message });
    }

    return { accepted: true, matchId: result.matchId };
  });

  server.post("/scrims/requests/:id/lineup", { preHandler: authedWrite }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ userIds: z.array(z.string().uuid()) }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "userIds is required" });
    }

    const confirmed = await scrim.confirmLineup(requireUser(req).userId, id, body.data.userIds);
    if (isFail(confirmed)) {
      return reply
        .code(scrimErrorStatus(confirmed.code))
        .send({ error: confirmed.code, message: confirmed.message });
    }

    if (!confirmed.data.ready) return { confirmed: true, awaitingLineup: true };

    const result = await commitScrim({
      requestId: id,
      listingId: confirmed.data.listingId,
      region: confirmed.data.region,
      hostTeamId: confirmed.data.hostTeamId,
      guestTeamId: confirmed.data.guestTeamId,
    });

    if (!result.ok) {
      return reply.code(409).send({ error: result.code, message: result.message });
    }

    return { confirmed: true, matchId: result.matchId };
  });

  // ------------------------------------------------------------------ ladder

  /**
   * The ladder, and where the reader sits on it.
   *
   * Your own position comes back whether or not it falls on the page being
   * read, so someone at 300th does not have to page down to find themselves.
   */
  server.get("/ladder", { preHandler: authenticate }, async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 100);
    const offset = Math.max(Number(q.offset ?? 0), 0);
    const user = requireUser(req);

    return {
      rows: await ladder.top(limit, offset),
      total: await ladder.count(),
      myPosition: await ladder.positionFor(user.userId),
      limit,
      offset,
    };
  });

  server.get("/players/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const profile = await ladder.profile(id);
    if (!profile) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "No such player" });
    }
    return profile;
  });

  // -------------------------------------------------------------------- chat

  /**
   * Who is allowed in a channel, and who hears what is said there.
   *
   * Membership is derived from the thing the channel belongs to rather than
   * stored alongside it, so a channel cannot outlive its party or match, and
   * there is no list to keep in step. Returns null when the reader has no
   * business there at all, which is the same answer for "not a member" and
   * "no such channel" -- both mean the same thing to someone asking.
   */
  async function chatAudience(channel: string, userId: string): Promise<string[] | null> {
    const [kind, id, sub] = channel.split(":");

    if (kind === "party" && id) {
      const partyId = await party.partyIdFor(userId);
      if (partyId !== id) return null;
      return party.memberIds([id]);
    }

    if (kind === "match" && id) {
      const parts = await lifecycle.participants(id);
      const me = parts.find((p) => p.userId === userId);
      if (!me) return null;

      if (!sub) return parts.map((p) => p.userId);

      // A team channel is the half of the match you are on, and only that half.
      const team = sub === "t1" ? 1 : sub === "t2" ? 2 : null;
      if (team === null || me.team !== team) return null;
      return parts.filter((p) => p.team === team).map((p) => p.userId);
    }

    return null;
  }

  server.get("/chat/:channel", { preHandler: authenticate }, async (req, reply) => {
    const { channel } = req.params as { channel: string };
    const user = requireUser(req);

    const audience = await chatAudience(channel, user.userId);
    if (!audience) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "Not your channel" });
    }

    return { channel, messages: chat.history(channel) };
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

  /**
   * Takes a report back, before the match is settled.
   *
   * Reporting could already be corrected into a different claim, but not
   * withdrawn -- so a captain who reported the wrong match, or reported while
   * the other side was still playing, had no way to say so.
   */
  server.delete("/match/:id/report", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = requireUser(req);

    const result = await reporting.withdraw(id, user.userId);
    if (isFail(result)) {
      return reply.code(409).send({ error: result.code, message: result.message });
    }

    const parts = await lifecycle.participants(id);
    notifier.toUsers(parts.map((p) => p.userId), {
      type: "match.state",
      matchId: id,
      state: result.data.state,
    });
    population.nudge();

    return result.data;
  });

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
    population.nudge();

    if (result.data.state === "COMPLETED" || result.data.state === "DISPUTED") {
      chat.clearMatch(id);
    }

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

  function requireGameMaster(req: FastifyRequest, reply: FastifyReply): boolean {
    const user = requireUser(req);
    if (!isGameMaster(user.role)) {
      void reply.code(403).send({ error: "FORBIDDEN", message: "Game Master access required" });
      return false;
    }
    return true;
  }

  server.get("/mod/disputes", { preHandler: authenticate }, async (req, reply) => {
    if (!requireGameMaster(req, reply)) return reply;
    return reporting.openDisputes();
  });

  const rulingBody = z.object({
    winner: z.enum(["TEAM1", "TEAM2"]),
    note: z.string().min(1).max(500),
  });

  server.post("/mod/disputes/:id/resolve", { preHandler: authenticate }, async (req, reply) => {
    if (!requireGameMaster(req, reply)) return reply;

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

  const suspendBody = z.object({
    hours: z.number().int().min(MIN_SUSPENSION_HOURS).max(MAX_SUSPENSION_HOURS),
    reason: z.string().min(1).max(SUSPENSION_REASON_MAX_LENGTH),
  });

  const moderationStatus = (code: string): number => {
    if (code === "USER_NOT_FOUND") return 404;
    if (code === "CANNOT_SUSPEND_STAFF") return 403;
    if (code.startsWith("INVALID_")) return 400;
    return 409;
  };

  /**
   * Ends a suspended player's session there and then.
   *
   * Without this a suspension only bites at the next login, which for someone
   * already signed in and queueing is no suspension at all. Sessions go first
   * so a reconnect cannot succeed, then the sockets, then the seat they were
   * holding in a party and queue.
   */
  async function evict(userId: string, reason: string): Promise<void> {
    notifier.toUser(userId, {
      type: "notification",
      level: "error",
      text: `Your account has been suspended. ${reason}`,
    });

    await sessions.revokeAllForUser(userId);

    const partyId = await party.partyIdFor(userId);
    if (partyId) {
      await queue.leave(partyId);
      const others = await party.memberCount(partyId);
      if (others > 1) {
        const left = await party.leave(userId);
        if (!isFail(left)) await broadcastParty(partyId);
      }
      notifier.toUsers(await party.memberIds([partyId]), { type: "queue.left", partyId });
    }

    // Last: the notification above has to reach them before the socket goes.
    notifier.closeUser(userId);
    population.nudge();
  }

  server.get("/mod/users", { preHandler: authenticate }, async (req, reply) => {
    if (!requireGameMaster(req, reply)) return reply;
    const q = String((req.query as Record<string, string>)?.q ?? "");
    return { users: await moderation.search(q) };
  });

  server.get("/mod/suspensions", { preHandler: authenticate }, async (req, reply) => {
    if (!requireGameMaster(req, reply)) return reply;
    return { users: await moderation.suspended() };
  });

  server.get("/mod/users/:id/history", { preHandler: authenticate }, async (req, reply) => {
    if (!requireGameMaster(req, reply)) return reply;
    const { id } = req.params as { id: string };
    return { entries: await moderation.historyFor(id) };
  });

  server.post("/mod/users/:id/suspend", { preHandler: authenticate }, async (req, reply) => {
    if (!requireGameMaster(req, reply)) return reply;

    const body = suspendBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "BAD_REQUEST",
        message: `A duration in hours (${MIN_SUSPENSION_HOURS}-${MAX_SUSPENSION_HOURS}) and a reason are required`,
      });
    }

    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const result = await moderation.suspend(
      { userId: user.userId, role: user.role },
      id,
      body.data.hours,
      body.data.reason,
    );
    if (isFail(result)) {
      return reply
        .code(moderationStatus(result.code))
        .send({ error: result.code, message: result.message });
    }

    await evict(id, result.data.reason);

    return {
      userId: result.data.userId,
      discordName: result.data.discordName,
      until: result.data.until.toISOString(),
      reason: result.data.reason,
    };
  });

  server.post("/mod/users/:id/reinstate", { preHandler: authenticate }, async (req, reply) => {
    if (!requireGameMaster(req, reply)) return reply;

    const note = z.object({ note: z.string().max(SUSPENSION_REASON_MAX_LENGTH).optional() });
    const body = note.safeParse(req.body ?? {});
    const user = requireUser(req);
    const { id } = req.params as { id: string };

    const result = await moderation.lift(
      { userId: user.userId, role: user.role },
      id,
      body.success ? (body.data.note ?? "") : "",
    );
    if (isFail(result)) {
      return reply
        .code(moderationStatus(result.code))
        .send({ error: result.code, message: result.message });
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
  notifier.onUserOffline = (userId) => {
    chat.forget(userId);
    scheduleDisconnectCheck(userId);
    population.nudge();
  };

  async function dropFromPartyIfStillGone(userId: string): Promise<void> {
    disconnectTimers.delete(userId);
    if (notifier.isOnline(userId)) return;

    const partyId = await party.partyIdFor(userId);
    if (!partyId) return;
    if ((await party.memberCount(partyId)) <= 1) return; // A solo party is theirs to keep.

    const result = await party.leave(userId);
    if (isFail(result)) return;

    await broadcastParty(partyId);

    // And the party they landed in, which has only them in it. It used to be
    // skipped on the grounds that there was nobody to tell -- but there is:
    // them, as soon as they are back. A client that reconnects after being
    // dropped this way was never sent its new party, so it went on showing the
    // roster it left, minus itself. That reads as "everyone else is still in a
    // party and I am not in it", which is precisely backwards.
    await broadcastParty(result.data.partyId);
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
    // Tell this socket where things stand before anything changes: a second
    // window for someone already online moves no number, so the broadcast its
    // arrival triggers would not be sent.
    population.greet(userId);
    population.nudge();
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

      // Chat rides the socket rather than a POST per line: it is the one
      // thing here sent often enough for the round trip to be worth avoiding.
      if (msg.type === "chat.send") {
        const { channel, text } = msg as { channel?: string; text?: string };
        if (typeof channel !== "string" || typeof text !== "string") return;

        void (async () => {
          const audience = await chatAudience(channel, userId);
          // Silence rather than an error: a channel you are not in and a
          // channel that does not exist are the same thing from outside.
          if (!audience) return;

          const posted = chat.post(
            channel,
            {
              userId,
              discordName: session.data.discordName,
              // Read once, when the socket connected. Somebody who sets their
              // in-game name mid-session keeps the old one on their chat lines
              // until they reconnect, which is a restart away and cheaper than
              // a database read on every message anyone sends.
              inGameName: session.data.inGameName,
              avatarUrl: session.data.avatarUrl,
              isGameMaster: isGameMaster(session.data.role),
            },
            text,
          );

          if (isFail(posted)) {
            notifier.toUser(userId, {
              type: "notification",
              level: "warn",
              text: posted.message,
            });
            return;
          }

          notifier.toUsers(audience, { type: "chat.message", channel, message: posted.data });
        })();
      }
    });

    socket.on("close", () => notifier.remove(userId, conn));
    socket.on("error", () => notifier.remove(userId, conn));
  });

  /**
   * Scrims nobody finished confirming.
   *
   * Runs on its own timer rather than the match sweeper's, because it is
   * about arrangements rather than matches -- nothing here has reached the
   * lifecycle yet.
   */
  async function sweepScrims(): Promise<void> {
    const dropped = await scrim.expireUnconfirmed();
    for (const d of dropped) {
      for (const teamId of d.teamIds) {
        notifier.toUsers(await team.memberIds(teamId), {
          type: "scrim.lineup.expired",
          requestId: d.requestId,
        });
      }
    }
  }

  let scrimSweep: NodeJS.Timeout | null = null;

  if (autoStart) {
    scrimSweep = setInterval(() => {
      void sweepScrims().catch((err) => server.log.error({ err }, "scrim sweep failed"));
    }, 1_000);
    scrimSweep.unref?.();
  }

  if (autoStart) {
    matchmaker.start();
    sweeper.start();
    population.start();
  }

  server.addHook("onClose", async () => {
    matchmaker.stop();
    sweeper.stop();
    population.stop();
    clearInterval(writePruner);
    if (scrimSweep) clearInterval(scrimSweep);
    notifier.closeAll();
  });

  return {
    server,
    notifier,
    population,
    matchmaker,
    sweeper,
    sweepScrims,
    services: { auth, sessions, party, queue, lifecycle, reporting, moderation, team, scrim, ladder, chat },
  };
}
