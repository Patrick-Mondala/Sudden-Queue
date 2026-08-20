import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/**
 * Environment loading and validation.
 *
 * Validated once at startup and thrown on immediately, so a missing secret
 * fails the process rather than surfacing as a confusing 500 later.
 */

/**
 * Finds the nearest .env by walking up from this module.
 *
 * The workspace keeps one .env at the repo root while the server runs from
 * apps/server, so looking only in the working directory finds nothing and every
 * variable reads as missing.
 */
function loadNearestEnvFile(): void {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Unreadable or malformed; fall through to real env vars.
      }
      return;
    }

    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // No .env anywhere: production supplies real environment variables.
}

loadNearestEnvFile();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().url(),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),

  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_REDIRECT_URI: z.string().url(),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }

  cached = parsed.data;
  return cached;
}
