/**
 * Grants or revokes a Game Master.
 *
 * Deliberately a script rather than anything reachable from the app. There is
 * no route that promotes an account, so the only way to become a Game Master is
 * for someone with the database to say so — which is the right shape for a
 * privilege that can overturn match results.
 *
 *   npm run grant -- --discord 130891065069666304 --role game_master
 *   npm run grant -- --discord 130891065069666304 --role player
 *   npm run grant -- --list
 */

import { eq, ne } from "drizzle-orm";

import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import { users } from "../src/db/schema/index.js";

const ROLES = ["player", "game_master", "admin"] as const;
type Role = (typeof ROLES)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

const { db, close } = createDatabase(loadConfig().DATABASE_URL, { max: 2 });

async function main(): Promise<void> {
  if (arg("list")) {
    const staff = await db
      .select({ discordId: users.discordId, name: users.discordName, role: users.role })
      .from(users)
      .where(ne(users.role, "player"));

    if (staff.length === 0) {
      console.log("No Game Masters.");
      return;
    }
    for (const s of staff) console.log(`${s.role.padEnd(12)} ${s.name} (${s.discordId})`);
    return;
  }

  const discordId = arg("discord");
  const role = (arg("role") ?? "game_master") as Role;

  if (!discordId) {
    console.error("Usage: npm run grant -- --discord <id> [--role game_master|player|admin]");
    process.exit(1);
  }
  if (!ROLES.includes(role)) {
    console.error(`Unknown role "${role}". Expected one of: ${ROLES.join(", ")}`);
    process.exit(1);
  }

  const rows = await db
    .update(users)
    .set({ role })
    .where(eq(users.discordId, discordId))
    .returning({ name: users.discordName, role: users.role });

  if (rows.length === 0) {
    // Nothing is created here: an account has to have signed in at least once,
    // so a typo cannot conjure a Game Master who does not exist.
    console.error(`No account with Discord id ${discordId}. They must sign in first.`);
    process.exit(1);
  }

  console.log(`${rows[0]!.name} is now ${rows[0]!.role}.`);
  // The session reads the role from the users table on every request, so this
  // is already true server-side; only the client is holding an older copy.
  console.log("In force now. Their app picks it up when it next reads /me.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => close());
