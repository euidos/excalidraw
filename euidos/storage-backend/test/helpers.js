import { after } from "node:test";

import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";

import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { createIdentityResolver } from "../src/identity.js";
import { createServer } from "../src/server.js";

export const AUD = "3a910158ce6aa3f8b0dff3fd29170d9485bd94fc69794e2fa48fb14c37a1e3d6";
export const TEAM_DOMAIN = "euidos.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;

const testEnv = (over = {}) => ({
  PORT: "0",
  PG_HOST: process.env.PG_HOST ?? "127.0.0.1",
  PG_PORT: process.env.PG_PORT ?? "55432",
  PG_USER: process.env.PG_USER ?? "postgres",
  PG_NAME: process.env.PG_NAME ?? "postgres",
  PG_PASSWORD: process.env.PG_PASSWORD ?? "test",
  ACCESS_AUD: AUD,
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ...over,
});

/** A locally generated RS256 key pair standing in for the Cloudflare JWKS. */
export async function makeAccessSigner({ kid = "test-key-1" } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = async (claims = {}, { audience = AUD, issuer = ISSUER } = {}) =>
    new SignJWT({ email: "staff@euidos.ai", ...claims })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("1h")
      .sign(privateKey);
  return { jwks, sign };
}

/**
 * Boot the service against the throwaway Postgres, with a clean schema and an
 * injected key set, and return a fetch helper bound to its ephemeral port.
 */
export async function startTestServer({ env = {}, jwks } = {}) {
  const config = loadConfig(testEnv(env));
  const pool = createPool(config.pg);
  await migrate(pool, { log: () => {} });
  await pool.query("TRUNCATE boards, scenes, files, blobs RESTART IDENTITY CASCADE");

  const resolveIdentity = createIdentityResolver({
    aud: config.accessAud,
    teamDomain: config.accessTeamDomain,
    jwks,
    log: () => {},
  });
  const server = createServer({ pool, config, resolveIdentity, log: () => {} });
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
    }
    return fetch(`${base}${path}`, { ...init, headers: h });
  };

  return { base, pool, server, call, close };
}
