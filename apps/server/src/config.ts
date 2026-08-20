import { z } from "zod";

/**
 * Environment loading and validation.
 *
 * Validated once at startup and thrown on immediately, so a missing secret
 * fails the process rather than surfacing as a confusing 500 later.
 */

// Node reads .env natively; ignore its absence so production can use real env vars.
try {
  process.loadEnvFile();
} catch {
  // no .env file present
}

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
