import {
  DEFAULT_RATING,
  MAX_PARTY_SIZE,
  REGIONS,
  isFail,
  isPlaced,
  placementGamesRemaining,
  tierForRating,
} from "@suddenqueue/core";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import { AuthService } from "./auth/service.js";
import { DiscordAuth } from "./auth/discord.js";
import { LoginHandoff } from "./auth/handoff.js";
import { SessionService, type SessionUser } from "./auth/sessions.js";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { playerRatings } from "./db/schema/index.js";
import { MatchLifecycle } from "./match/lifecycle.js";
import { MatchReporting } from "./match/reporting.js";
import { Matchmaker, MatchSweeper } from "./matchmaker/loop.js";
import { PartyService } from "./party/service.js";
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

export async function buildApp({ db, config, autoStart = true }: AppDeps): Promise<App> {
  const server = Fastify({ logger: config.NODE_ENV !== "test" });

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
  const queue = new QueueRepository(db);
  const lifecycle = new MatchLifecycle(db);
  const reporting = new MatchReporting(db);

  // ---------------------------------------------------------------- realtime

  const matchmaker = new Matchmaker(queue, lifecycle, {
    onMatchCreated: async (match) => {
      const detail = await lifecycle.participants(match.matchId);
      notifier.toUsers(match.userIds, {
        type: "match.found",
        matchId: match.matchId,
        acceptDeadline: match.acceptDeadline.toISOString(),
        match: { participants: detail },
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
    onCancelled: async (matchId, missed, kept) => {
      // Everyone hears about it, but only the people who missed are told they
      // are at fault — the other nine did nothing wrong.
      notifier.toUsers(missed, {
        type: "match.cancelled",
        matchId,
        reason: "ACCEPT_TIMEOUT",
        atFault: true,
      });
      notifier.toUsers(kept, {
        type: "match.cancelled",
        matchId,
        reason: "ACCEPT_TIMEOUT",
        atFault: false,
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

  server.post("/party/invite", { preHandler: authenticate }, async (req, reply) => {
    const body = z.object({ userId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "userId is required" });
    }

    const user = requireUser(req);
    const result = await party.invite(user.userId, body.data.userId);
    if (isFail(result)) {
      return reply.code(409).send({ error: result.code, message: result.message });
    }

    notifier.toUser(body.data.userId, {
      type: "party.invite.received",
      invite: {
        inviteId: result.data.inviteId,
        partyId: result.data.partyId,
        fromUserId: user.userId,
        fromName: user.discordName,
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
    return result.data;
  });

  server.post("/party/invite/:id/decline", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await party.decline(requireUser(req).userId, id);
    if (isFail(result)) {
      return reply.code(404).send({ error: result.code, message: result.message });
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
  }));

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
      // Each player is told their own delta, not the whole table.
      for (const change of result.data.ratingChanges ?? []) {
        notifier.toUser(change.userId, {
          type: "match.resolved",
          matchId: id,
          result: result.data.winner ?? "",
          ratingDelta: change.delta,
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
        ratingDelta: change.delta,
      });
    }

    return result.data;
  });

  server.get("/match/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const match = await lifecycle.getMatch(id);
    if (!match) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "Match not found" });
    }

    const parts = await lifecycle.participants(id);
    const user = requireUser(req);
    if (!parts.some((p) => p.userId === user.userId) && user.role === "player") {
      return reply.code(403).send({ error: "FORBIDDEN", message: "Not your match" });
    }

    return { match, participants: parts };
  });

  // ---------------------------------------------------------------- websocket

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
          if (partyId) void queue.heartbeat(partyId);
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
    services: { auth, sessions, party, queue, lifecycle, reporting },
  };
}
