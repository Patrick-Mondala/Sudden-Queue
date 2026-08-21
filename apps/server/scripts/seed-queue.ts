/**
 * Dev-only: fill the queue with test players so a match can actually form.
 *
 * A match needs ten players, so a single real account can never pop one. This
 * seeds the rest and then plays their side of the whole flow -- accepting, and
 * reporting once you report -- so the loop is reachable solo, all the way
 * through to a rating change.
 *
 * The bots act over HTTP against the running server rather than writing to the
 * database directly. Going through the real routes is the point: that is what
 * fires the websocket events your client is waiting on. A bot that accepted by
 * UPDATE would leave your app sitting on a prompt that never resolves.
 *
 * Every account it creates is prefixed `seed:` so `--cleanup` removes them
 * without touching real players.
 *
 * The default is nine, one short of a match, so the tenth slot is yours and the
 * matchmaker cannot fill it without you. Seeding a full ten is for testing the
 * server unattended; see the warning below before doing it while queued.
 *
 *   npm run seed                          # 9 bots + you = one match
 *   npm run seed -- --region eu --rating 1500
 *   npm run seed -- --count 10 --play false   # a match with no human in it
 *   npm run seed -- --cleanup
 */

import {
  DEFAULT_RATING,
  MATCH_SIZE,
  QUEUE_HEARTBEAT_INTERVAL_SECONDS,
  REGIONS,
} from "@suddenqueue/core";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { SessionService } from "../src/auth/sessions.js";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import {
  matchParticipants,
  matchReports,
  matches,
  parties,
  partyMembers,
  playerRatings,
  queueTickets,
  users,
} from "../src/db/schema/index.js";

const SEED_PREFIX = "seed:";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

const config = loadConfig();

if (config.NODE_ENV === "production") {
  console.error("Refusing to seed a production database.");
  process.exit(1);
}

const { db, close } = createDatabase(config.DATABASE_URL, { max: 4 });
const sessionsService = new SessionService(db);

const count = Number(arg("count", String(MATCH_SIZE - 1)));
const region = arg("region", "na")!;
const baseRating = Number(arg("rating", String(DEFAULT_RATING)));
const spread = Number(arg("spread", "60"));
const play = arg("play", "true") !== "false";
const cleanup = arg("cleanup") === "true";
const baseUrl = arg("url", `http://127.0.0.1:${config.PORT}`)!;

/** Minutes to shadow the match for. Party-up alone is two of them. */
const WATCH_MINUTES = Number(arg("watch", "8"));

interface Bot {
  userId: string;
  name: string;
  token: string;
}

/** Set once the bots are connected; closes their sockets on the way out. */
let disconnectBots: () => void = () => {};

async function send(
  path: string,
  token: string,
  payload?: unknown,
): Promise<{ ok: boolean; body: unknown }> {
  // Declaring a JSON content-type with no body is a 400: Fastify believes the
  // header over the empty payload. Body-less actions send no content-type.
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { ok: res.ok, body: await res.json().catch(() => null) };
}

async function serverIsUp(): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/health`)).ok;
  } catch {
    return false;
  }
}

async function removeSeeded(): Promise<number> {
  const rows = await db
    .delete(users)
    .where(like(users.discordId, `${SEED_PREFIX}%`))
    .returning({ id: users.id });

  // Parties are not cascaded from every direction, so sweep any left empty.
  await db.execute(sql`
    DELETE FROM parties p
    WHERE NOT EXISTS (SELECT 1 FROM party_members m WHERE m.party_id = p.id)
  `);

  return rows.length;
}

async function seed(): Promise<Bot[]> {
  if (!REGIONS.includes(region as (typeof REGIONS)[number])) {
    console.error(`Unknown region "${region}". Expected one of: ${REGIONS.join(", ")}`);
    process.exit(1);
  }

  const bots: Bot[] = [];

  for (let i = 0; i < count; i += 1) {
    // Spread ratings a little so the matchmaker has something to balance rather
    // than every candidate scoring identically.
    const rating = baseRating + Math.round((Math.random() * 2 - 1) * spread);
    const stamp = `${Date.now().toString(36)}${i}`;
    const name = `Bot${String(i + 1).padStart(2, "0")}`;

    const [user] = await db
      .insert(users)
      .values({
        discordId: `${SEED_PREFIX}${stamp}`,
        discordName: name,
        inGameName: `BOT_${String(i + 1).padStart(2, "0")}`,
      })
      .returning({ id: users.id });

    await db.insert(playerRatings).values({
      userId: user!.id,
      rating,
      peakRating: rating,
      // Past placements, so they behave like settled ladder players and show a
      // rank on the roster instead of a dash.
      gamesPlayed: 40,
      wins: 20,
      losses: 20,
    });

    const [party] = await db
      .insert(parties)
      .values({ leaderId: user!.id })
      .returning({ id: parties.id });
    await db.insert(partyMembers).values({ partyId: party!.id, userId: user!.id });

    await db.insert(queueTickets).values({
      partyId: party!.id,
      regions: [region],
      ratingSnapshot: rating,
      size: 1,
    });

    const { token } = await sessionsService.create(user!.id);
    bots.push({ userId: user!.id, name, token });
  }

  return bots;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Holds each bot's queue slot open.
 *
 * A queue ticket is only alive while its client keeps heartbeating -- twenty
 * seconds of silence and the matchmaker prunes it as a closed app. Bots with no
 * socket therefore evaporate before you finish queueing, and you watch the
 * count climb and then collapse. Connecting for real is also the honest test:
 * these are the same sockets the notifier pushes match.found down.
 */
function connectBots(bots: Bot[]): () => void {
  const wsBase = baseUrl.replace(/^http/, "ws");
  const sockets: WebSocket[] = [];
  const timers: NodeJS.Timeout[] = [];

  for (const bot of bots) {
    const socket = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(bot.token)}`);
    sockets.push(socket);

    socket.addEventListener("open", () => {
      const beat = () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "heartbeat" }));
        }
      };
      beat();
      timers.push(setInterval(beat, QUEUE_HEARTBEAT_INTERVAL_SECONDS * 1000));
    });

    // Nothing to do with what the server pushes; the script watches the
    // database directly. The socket exists to prove liveness.
    socket.addEventListener("error", () => {});
  }

  return () => {
    for (const t of timers) clearInterval(t);
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        // Already closing.
      }
    }
  };
}

/** Resolves once every bot is connected, or the wait runs out. */
async function waitForConnections(botCount: number): Promise<void> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const res = await fetch(`${baseUrl}/queue/stats`).catch(() => null);
    const stats = (await res?.json().catch(() => null)) as { online?: number } | null;
    if ((stats?.online ?? 0) >= botCount) return;
    await sleep(250);
  }
}

/** The match these bots were pulled into, if the matchmaker has run. */
async function findMatch(botIds: string[]): Promise<string | null> {
  const [row] = await db
    .select({ matchId: matchParticipants.matchId })
    .from(matchParticipants)
    .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
    .where(
      and(
        inArray(matchParticipants.userId, botIds),
        inArray(matches.state, ["PENDING_ACCEPT", "PARTY_UP", "LIVE", "REPORTED"]),
      ),
    )
    .limit(1);

  return row?.matchId ?? null;
}

/**
 * Plays the bots' side of one match: accept, then report.
 *
 * Reporting mirrors whatever the human captain claimed, because a bot that
 * disagreed would push the match into dispute and no rating would move -- the
 * opposite of what you seeded for. If both captains happen to be bots, one
 * picks, so the loop still finishes.
 */
async function playMatch(matchId: string, bots: Bot[]): Promise<void> {
  const byId = new Map(bots.map((b) => [b.userId, b]));
  const deadline = Date.now() + WATCH_MINUTES * 60_000;
  let accepted = false;
  let reported = false;
  let announcedParty = false;

  while (Date.now() < deadline) {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return;

    if (match.state === "CANCELLED") {
      console.log("  match cancelled — somebody did not accept in time");
      return;
    }

    if (match.state === "COMPLETED" || match.state === "DISPUTED") {
      const deltas = await db
        .select({ userId: matchParticipants.userId, delta: matchParticipants.ratingDelta })
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, matchId));

      const yours = deltas.find((d) => !byId.has(d.userId) && d.delta !== null);
      const suffix = yours ? ` — your rating moved ${yours.delta! > 0 ? "+" : ""}${yours.delta}` : "";
      console.log(`  match ${match.state.toLowerCase()}${suffix}`);
      return;
    }

    const parts = await db
      .select()
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, matchId));

    if (match.state === "PENDING_ACCEPT" && !accepted) {
      const pending = parts.filter((p) => byId.has(p.userId) && p.acceptedAt === null);
      for (const p of pending) {
        const bot = byId.get(p.userId)!;
        const res = await send(`/match/${matchId}/accept`, bot.token);
        if (!res.ok) console.log(`  ${bot.name} could not accept:`, res.body);
      }
      if (pending.length > 0) {
        console.log(`  ${pending.length} bot(s) accepted — waiting on you`);
        accepted = true;
      }
    }

    if (match.state === "PARTY_UP" && !announcedParty) {
      console.log("  everyone accepted — party up (the server goes live in ~2 min)");
      announcedParty = true;
    }

    if ((match.state === "LIVE" || match.state === "REPORTED") && !reported) {
      const botCaptains = parts.filter((p) => p.isCaptain && byId.has(p.userId));
      const humanCaptain = parts.find((p) => p.isCaptain && !byId.has(p.userId));

      const existing = await db
        .select()
        .from(matchReports)
        .where(eq(matchReports.matchId, matchId));

      // Let the human go first so the bots can agree with them.
      if (humanCaptain && existing.length === 0) {
        await sleep(2000);
        continue;
      }

      const claimed = existing[0]?.claimedWinner ?? (Math.random() < 0.5 ? "TEAM1" : "TEAM2");

      for (const cap of botCaptains) {
        if (existing.some((r) => r.reporterId === cap.userId)) continue;
        const bot = byId.get(cap.userId)!;
        const res = await send(`/match/${matchId}/report`, bot.token, { winner: claimed });
        if (res.ok) console.log(`  ${bot.name} (captain) reported ${claimed}`);
        else console.log(`  ${bot.name} could not report:`, res.body);
      }
      reported = true;
    }

    await sleep(2000);
  }

  console.log("  stopped watching (--watch minutes elapsed)");
}

async function main(): Promise<void> {
  if (cleanup) {
    const removed = await removeSeeded();
    console.log(`Removed ${removed} seeded account${removed === 1 ? "" : "s"}.`);
    return;
  }

  if (play && !(await serverIsUp())) {
    console.error(`No server at ${baseUrl}. Start it with "npm run server" first.`);
    process.exit(1);
  }

  if (count >= MATCH_SIZE) {
    // The matchmaker anchors on the longest-waiting ticket, and these bots
    // queue before you do. Give it a full ten and it can build a match out of
    // bots alone and leave you sitting in the queue watching it happen.
    console.warn(
      `Warning: ${count} bots is a full match on its own. They queue ahead of you,` +
        ` so they can match with each other and leave you queued.` +
        ` Use ${MATCH_SIZE - 1} to keep a slot open for yourself.`,
    );
    console.log("");
  }

  console.log(`Seeding ${count} player(s) into the ${region.toUpperCase()} queue at ~${baseRating}...`);
  const bots = await seed();
  console.log(`  created ${bots.length} queued bot(s)`);

  // Without this they are pruned twenty seconds later and the queue count
  // collapses back to just you.
  disconnectBots = connectBots(bots);
  await waitForConnections(bots.length);
  console.log(`  ${bots.length} bot(s) connected and holding their queue slots`);

  console.log("");
  console.log(`Queue up in ${region.toUpperCase()} now — the matchmaker runs every 2s.`);

  if (play) {
    console.log("Watching. The bots accept, then report to match whatever you report.");

    const botIds = bots.map((b) => b.userId);
    const until = Date.now() + WATCH_MINUTES * 60_000;

    let matchId: string | null = null;
    while (!matchId && Date.now() < until) {
      matchId = await findMatch(botIds);
      if (!matchId) await sleep(1000);
    }

    if (!matchId) console.log("  no match formed. Are you queued in the same region?");
    else {
      console.log(`  match ${matchId}`);
      await playMatch(matchId, bots);
    }
  } else {
    // The bots exist only as long as this process holds their sockets open, so
    // exiting here would prune them twenty seconds later and undo the seed.
    console.log("Holding the queue open. Ctrl+C to release the bots.");
    await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
  }

  console.log("");
  console.log("Clean up afterwards with:  npm run seed -- --cleanup");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    disconnectBots();
    return close();
  });
