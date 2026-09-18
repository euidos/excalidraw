import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";

const pgEnv = () => ({
  PG_HOST: process.env.PG_HOST ?? "127.0.0.1",
  PG_PORT: process.env.PG_PORT ?? "55432",
  PG_USER: process.env.PG_USER ?? "postgres",
  PG_NAME: process.env.PG_NAME ?? "postgres",
  PG_PASSWORD: process.env.PG_PASSWORD ?? "test",
});

describe("migrations", () => {
  test("apply in order, record themselves and are a no-op the second time", async () => {
    const config = loadConfig(pgEnv());
    const pool = createPool(config.pg);
    try {
      await migrate(pool, { log: () => {} });
      const again = await migrate(pool, { log: () => {} });
      assert.deepEqual(again, [], "second run applies nothing");

      const { rows } = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
      assert.deepEqual(
        rows.map((r) => r.version),
        ["001_init.sql", "002_scene_elements_json.sql"],
      );

      const elements = await pool.query(
        `SELECT udt_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'scenes' AND column_name = 'elements'`,
      );
      assert.equal(elements.rows[0].udt_name, "json", "jsonb cannot hold a NUL");

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

  // The live database was created by 001 alone (elements jsonb). Prove the
  // upgrade path, not just a green-field install.
  test("002 upgrades a live 001-only database in place", async () => {
    const admin = createPool(loadConfig(pgEnv()).pg);
    const dbName = `upgrade_${Date.now()}`;
    let pool;
    let onlyFirst;
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
      onlyFirst = await mkdtemp(path.join(tmpdir(), "boards-mig-"));
      const from = fileURLToPath(new URL("../migrations/001_init.sql", import.meta.url));
      await copyFile(from, path.join(onlyFirst, "001_init.sql"));

      pool = createPool({ ...loadConfig(pgEnv()).pg, database: dbName });
      await migrate(pool, { dir: `${onlyFirst}/`, log: () => {} });

      const before = await pool.query(
        `SELECT udt_name FROM information_schema.columns
          WHERE table_name = 'scenes' AND column_name = 'elements'`,
      );
      assert.equal(before.rows[0].udt_name, "jsonb", "001 alone still means jsonb");

      await pool.query(
        `INSERT INTO boards (id, name, created_by, updated_by) VALUES ('b', 'B', 'x', 'x')`,
      );
      await pool.query(
        `INSERT INTO scenes (board_id, elements, version) VALUES ('b', $1::jsonb, 4)`,
        [JSON.stringify([{ id: "one" }, { id: "two" }])],
      );

      const ran = await migrate(pool, { log: () => {} });
      assert.deepEqual(ran, ["002_scene_elements_json.sql"]);

      const after = await pool.query(
        `SELECT udt_name FROM information_schema.columns
          WHERE table_name = 'scenes' AND column_name = 'elements'`,
      );
      assert.equal(after.rows[0].udt_name, "json");

      const row = await pool.query("SELECT elements, element_count, version FROM scenes");
      assert.deepEqual(row.rows[0].elements, [{ id: "one" }, { id: "two" }], "data survived");
      assert.equal(row.rows[0].element_count, 2, "backfilled");
      assert.equal(row.rows[0].version, 4, "the version counter survived");

      assert.deepEqual(await migrate(pool, { log: () => {} }), [], "idempotent");

      // and a NUL, which used to 500 forever, now stores
      await pool.query(`UPDATE scenes SET elements = $1::json`, [
        JSON.stringify([{ text: `a${String.fromCharCode(0)}b` }]),
      ]);
    } finally {
      if (pool) await pool.end();
      if (onlyFirst) await rm(onlyFirst, { recursive: true, force: true });
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  });
});
