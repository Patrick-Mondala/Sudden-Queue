import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://suddenqueue:suddenqueue_dev@localhost:5432/suddenqueue",
  },
  strict: true,
  verbose: true,
});
