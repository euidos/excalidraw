import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";

describe("migrations", () => {
  test("apply in order, record themselves and are a no-op the second time", async () => {
    const config = loadConfig({
      PG_HOST: process.env.PG_HOST ?? "127.0.0.1",
      PG_PORT: process.env.PG_PORT ?? "55432",
      PG_USER: process.env.PG_USER ?? "postgres",
      PG_NAME: process.env.PG_NAME ?? "postgres",
      PG_PASSWORD: process.env.PG_PASSWORD ?? "test",
    });
    const pool = createPool(config.pg);
    try {
      await migrate(pool, { log: () => {} });
      const again = await migrate(pool, { log: () => {} });
      assert.deepEqual(again, [], "second run applies nothing");

      const { rows } = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
      assert.deepEqual(
        rows.map((r) => r.version),
        ["001_init.sql"],
      );

      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'`,
      );
      assert.deepEqual(
        tables.rows.map((r) => r.table_name).sort(),
        ["blobs", "boards", "files", "scenes", "schema_migrations"],
      );
    } finally {
      await pool.end();
    }
  });
});
