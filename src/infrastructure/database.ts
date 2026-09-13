import pg from "pg";
import environment from "../config/environment.js";

const { Pool } = pg;

/**
 * Single Postgres connection pool, configured from the validated DATABASE_URL.
 * There is intentionally only one supported way to configure the database
 * connection — a previous revision also read DB_HOST/DB_USER/DB_PASSWORD/etc
 * directly, which silently diverged from DATABASE_URL and made local config
 * confusing. DATABASE_URL is now the single source of truth.
 *
 * For local development without TLS, a typical value looks like:
 *   postgres://user:password@localhost:5432/bot_01
 */
export const pool = new Pool({
  connectionString: environment.DATABASE_URL,
});

pool.on("error", (err) => {
  // Idle client errors (e.g. connection dropped by the server) should not
  // crash the process silently without a log line.
  console.error("[DB] Unexpected idle client error:", err.message);
});

export async function query(text: string, params?: unknown[]) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;

  if (environment.LOG_LEVEL === "debug") {
    console.log(`[DB] Executed query in ${duration}ms | rows: ${res.rowCount}`);
  }

  return res;
}
