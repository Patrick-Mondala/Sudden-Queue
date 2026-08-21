import { DEFAULT_RATING } from "@suddenqueue/core";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { createDatabase } from "../db/client.js";
import { parties, partyMembers, playerRatings, users } from "../db/schema/index.js";

/**
 * Integration test harness.
 *
 * These repositories are almost entirely SQL — locking, conflict handling,
 * array containment, cascade behaviour. Mocking the database would test the
 * mock, so tests run against a real Postgres on a dedicated database that is
 * created once and truncated between cases.
 */

const ADMIN_URL =
  process.env.DATABASE_URL ??
  "postgresql://suddenqueue:suddenqueue_dev@localhost:5432/suddenqueue";

export const TEST_DB_NAME = "suddenqueue_test";

function testUrl(): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${TEST_DB_NAME}`;
  return u.toString();
}

/** Creates the test database if absent and applies migrations. */
export async function setupTestDatabase() {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    const existing = await admin`SELECT 1 FROM pg_database WHERE datname = ${TEST_DB_NAME}`;
    if (existing.length === 0) {
      await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const handle = createDatabase(testUrl(), { max: 4 });
  await migrate(handle.db, { migrationsFolder: "./drizzle" });
  return handle;
}

/**
 * Empties every table between tests. RESTART IDENTITY CASCADE keeps foreign
 * keys satisfied without needing a delete order.
 */
export async function truncateAll(handle: Awaited<ReturnType<typeof setupTestDatabase>>) {
  await handle.db.execute(sql`
    TRUNCATE TABLE
      match_reports, match_participants, rating_adjustments, disputes, matches,
      queue_tickets, party_invites, party_members, parties,
      team_applications, scrim_requests, scrim_listings, team_members, teams,
      sessions, player_ratings, audit_log, users
    RESTART IDENTITY CASCADE
  `);
}

let userSeq = 0;

/** Creates a user with a rating profile. */
export async function makeUser(
  handle: Awaited<ReturnType<typeof setupTestDatabase>>,
  opts: { rating?: number; gamesPlayed?: number } = {},
): Promise<string> {
  userSeq += 1;
  const rating = opts.rating ?? DEFAULT_RATING;

  const [user] = await handle.db
    .insert(users)
    .values({
      discordId: `discord-${userSeq}-${Date.now()}`,
      discordName: `player${userSeq}`,
      inGameName: `PLAYER${userSeq}`,
    })
    .returning({ id: users.id });

  await handle.db.insert(playerRatings).values({
    userId: user!.id,
    rating,
    peakRating: rating,
    gamesPlayed: opts.gamesPlayed ?? 0,
  });

  return user!.id;
}

/** Creates a party of `size` new users and returns its id plus members. */
export async function makeParty(
  handle: Awaited<ReturnType<typeof setupTestDatabase>>,
  size: number,
  opts: { rating?: number; gamesPlayed?: number } = {},
): Promise<{ partyId: string; userIds: string[] }> {
  const userIds: string[] = [];
  for (let i = 0; i < size; i += 1) {
    userIds.push(await makeUser(handle, opts));
  }

  const [party] = await handle.db
    .insert(parties)
    .values({ leaderId: userIds[0]! })
    .returning({ id: parties.id });

  await handle.db
    .insert(partyMembers)
    .values(userIds.map((userId) => ({ partyId: party!.id, userId })));

  return { partyId: party!.id, userIds };
}
