import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

// bigint/numeric counts come back as strings by default; we only count small ints.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));

export function createPool(config) {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    password: config.password,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/**
 * Apply every migrations/*.sql not yet recorded, in filename order, each in its
 * own transaction. Idempotent: already-applied files are skipped, and the SQL
 * itself is written to be safe to re-run.
 */
export async function migrate(pool, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await pool.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
  );

  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [file],
      );
      await client.query("COMMIT");
      ran.push(file);
      log(`migrate applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return ran;
}

export async function waitForDb(pool, { attempts = 30, delayMs = 1000, log = console.log } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      lastErr = err;
      log(`db not ready (attempt ${i}/${attempts})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
