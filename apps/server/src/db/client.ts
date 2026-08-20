import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof createDatabase>["db"];

/** The handle Drizzle hands to a transaction callback. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Anything that can run a query. A transaction is not assignable to Database
 * (it has no `$client`), so repository methods that may run inside one take
 * this instead.
 */
export type Executor = Database | Transaction;

/**
 * Opens a connection pool and returns the Drizzle handle alongside the raw
 * client, so callers can close it deterministically (tests, shutdown hooks).
 */
export function createDatabase(url: string, options: { max?: number } = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    // Drizzle handles its own type parsing; keep timestamps as Date objects.
    onnotice: () => {},
  });

  return {
    db: drizzle(sql, { schema }),
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}

export { schema };
