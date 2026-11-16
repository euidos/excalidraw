import { after } from "node:test";

import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { createServer } from "../src/server.js";

const testEnv = (over = {}) => ({
  PORT: "0",
  PG_HOST: process.env.PG_HOST ?? "127.0.0.1",
  PG_PORT: process.env.PG_PORT ?? "55432",
  PG_USER: process.env.PG_USER ?? "postgres",
  PG_NAME: process.env.PG_NAME ?? "postgres",
  PG_PASSWORD: process.env.PG_PASSWORD ?? "test",
  ...over,
});

/**
 * Boot the service against the throwaway Postgres, with a clean schema, and return a fetch helper bound to its ephemeral port.
 */
export async function startTestServer({ env = {} } = {}) {
  const config = loadConfig(testEnv(env));
  const pool = createPool(config.pg);
  await migrate(pool, { log: () => {} });
  await pool.query("TRUNCATE boards, scenes, files, blobs RESTART IDENTITY CASCADE");

  const server = createServer({ pool, config, log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  };
  after(close);

  const call = (path, { headers = {}, identity = "tailnet", ...init } = {}) => {
    const h = { ...headers };
    if (identity === "tailnet") {
      h["x-euidos-listener"] = "tailnet";
      h["tailscale-user-login"] = h["tailscale-user-login"] ?? "staff@euidos.ai";
    } else if (identity === "wall") {
      h["x-euidos-listener"] = "tailnet";
    } else if (identity === "login") {
      h["x-euidos-listener"] = "login";
      h["x-authentik-email"] = h["x-authentik-email"] ?? "staff@euidos.ai";
    }
    return fetch(`${base}${path}`, { ...init, headers: h });
  };

  return { base, pool, server, call, close };
}
