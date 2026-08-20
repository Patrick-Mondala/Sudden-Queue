import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";

const config = loadConfig();
const { db, close } = createDatabase(config.DATABASE_URL);

const app = await buildApp({ db, config });

async function shutdown(signal: string): Promise<void> {
  app.server.log.info({ signal }, "shutting down");
  try {
    // Close HTTP first so no new work arrives, then drain the pool.
    await app.server.close();
    await close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.server.listen({ port: config.PORT, host: "0.0.0.0" });
