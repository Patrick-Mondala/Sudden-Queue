/**
 * Dev-only: fill the queue with test players so a match can actually form.
 *
 * A match needs ten players, so a single real account can never pop one. This
 * seeds the rest, and by default plays their side of the flow — accepting the
 * match when it appears — so the whole loop is reachable solo.
 *
 * Every account it creates is prefixed `seed:` so `--cleanup` can remove them
 * without touching real players.
 *
 *   npm run seed -- --count 9 --region na --rating 1200
 *   npm run seed -- --cleanup
 */

import {
  ACCEPT_WINDOW_SECONDS,
  DEFAULT_RATING,
  MATCH_SIZE,
  REGIONS,
} from "@suddenqueue/core";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import {
  matchParticipants,
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

const count = Number(arg("count", String(MATCH_SIZE - 1)));
const region = arg("region", "na")!;
const baseRating = Number(arg("rating", String(DEFAULT_RATING)));
const spread = Number(arg("spread", "60"));
const autoAccept = arg("accept", "true") !== "false";
const cleanup = arg("cleanup") === "true";

async function removeSeeded(): Promise<number> {
  const rows = await db
    .delete(users)
    .where(like(users.discordId, `${SEED_PREFIX}%`))
    .returning({ id: users.id });

  // Parties are not owned by users via cascade in every direction, so sweep
  // any that were left without members.
  await db.execute(sql`
    DELETE FROM parties p
    WHERE NOT EXISTS (SELECT 1 FROM party_members m WHERE m.party_id = p.id)
  `);

  return rows.length;
}

async function seed(): Promise<string[]> {
  if (!REGIONS.includes(region as (typeof REGIONS)[number])) {
    console.error(`Unknown region "${region}". Expected one of: ${REGIONS.join(", ")}`);
    process.exit(1);
  }

  const created: string[] = [];

  for (let i = 0; i < count; i += 1) {
    // Spread ratings a little so the matchmaker has something to balance
    // rather than every candidate scoring identically.
    const rating = baseRating + Math.round((Math.random() * 2 - 1) * spread);
    const stamp = `${Date.now().toString(36)}${i}`;

    const [user] = await db
      .insert(users)
      .values({
        discordId: `${SEED_PREFIX}${stamp}`,
        discordName: `Bot${String(i + 1).padStart(2, "0")}`,
        inGameName: `BOT_${String(i + 1).padStart(2, "0")}`,
      })
      .returning({ id: users.id });

    await db.insert(playerRatings).values({
      userId: user!.id,
      rating,
      peakRating: rating,
      // Past placements, so they behave like settled ladder players.
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

    created.push(user!.id);
  }

  return created;
}

/**
 * Accepts on behalf of seeded players once a match appears.
 *
 * Without this the match dies on the accept timer and the real player never
 * gets past the prompt.
 */
async function acceptForSeeded(userIds: string[]): Promise<void> {
  const deadline = Date.now() + (ACCEPT_WINDOW_SECONDS + 20) * 1000;
  let announced = false;

  while (Date.now() < deadline) {
    const pending = await db
      .select({ matchId: matchParticipants.matchId, userId: matchParticipants.userId })
      .from(matchParticipants)
      .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
      .where(
        and(
          inArray(matchParticipants.userId, userIds),
          eq(matches.state, "PENDING_ACCEPT"),
        ),
      );

    if (pending.length > 0) {
      if (!announced) {
        console.log(`  match found (${pending[0]!.matchId}) — accepting for bots`);
        announced = true;
      }

      await db
        .update(matchParticipants)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            inArray(
              matchParticipants.userId,
              pending.map((p) => p.userId),
            ),
            eq(matchParticipants.matchId, pending[0]!.matchId),
          ),
        );

      const [counts] = await db
        .select({
          total: sql<number>`COUNT(*)::int`,
          accepted: sql<number>`COUNT(${matchParticipants.acceptedAt})::int`,
        })
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, pending[0]!.matchId));

      console.log(`  accepted: ${counts?.accepted}/${counts?.total} — waiting on you`);
      return;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("  no match formed. Is the server running, and are you queued in the same region?");
}

async function main(): Promise<void> {
  if (cleanup) {
    const removed = await removeSeeded();
    console.log(`Removed ${removed} seeded account${removed === 1 ? "" : "s"}.`);
    return;
  }

  console.log(`Seeding ${count} player(s) into the ${region.toUpperCase()} queue at ~${baseRating}...`);
  const ids = await seed();
  console.log(`  created ${ids.length} queued bot(s)`);
  console.log("");
  console.log(`Queue up in ${region.toUpperCase()} now — the matchmaker runs every 2s.`);

  if (autoAccept) {
    console.log("Watching for the match...");
    await acceptForSeeded(ids);
    console.log("");
    console.log("Accept in the app, then the match moves to party-up.");
  }

  console.log("");
  console.log("Clean up afterwards with:  npm run seed -- --cleanup");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => close());
