import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These are integration tests against one shared Postgres database, and
    // each file truncates between cases. Running files in parallel lets one
    // file's truncate wipe rows another is still using, which surfaces as
    // spurious foreign-key violations. Sequential files, parallel-safe within.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
