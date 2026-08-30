import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

/**
 * Loads the nearest .env, the same way the server does.
 *
 * drizzle-kit runs this file on its own, so nothing in src/ has executed and
 * nothing has read .env. Without this it falls through to the development
 * fallback below -- which on a developer's machine happens to be the right
 * credentials, and on a real deployment is the wrong password and an error
 * drizzle-kit reports as a bare exit code.
 */
function loadNearestEnvFile(): void {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Unreadable or malformed; real environment variables still apply.
      }
      return;
    }

    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
}

loadNearestEnvFile();

const url = process.env.DATABASE_URL;
if (!url) {
  // Better than a fallback that silently migrates the wrong database.
  throw new Error(
    "DATABASE_URL is not set and no .env was found.\n" +
      "Copy .env.example to .env, or set DATABASE_URL in the environment.",
  );
}

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
