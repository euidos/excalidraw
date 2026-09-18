import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { AUD, makeAccessSigner, startTestServer } from "./helpers.js";

describe("health and identity", () => {
  test("GET /api/health needs no identity and reports the db", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/health", { identity: "none" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, db: "ok" });
  });

  test("401 without any identity header", async () => {
    const { call } = await startTestServer();
    for (const path of ["/api/me", "/api/boards", "/api/rooms/abc"]) {
      const res = await call(path, { identity: "none" });
      assert.equal(res.status, 401, path);
      assert.equal((await res.json()).error, "unauthorized");
    }
  });

  test("tailnet listener + Tailscale-User-Login -> via tailnet", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/me", {
      headers: { "tailscale-user-login": "w@euidos.ai", "tailscale-user-name": "W" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { login: "w@euidos.ai", name: "W", via: "tailnet" });
  });

  test("tailnet listener without a user (tagged device) -> the wall", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/me", { identity: "wall" });
    assert.deepEqual(await res.json(), { login: "wall", name: "Wall", via: "wall" });
  });

  test("a listener marker other than 'tailnet' is untrusted -> 401", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/me", {
      identity: "none",
      headers: { "x-euidos-listener": "tunnel", "tailscale-user-login": "spoof@euidos.ai" },
    });
    assert.equal(res.status, 401);
  });

  test("a valid Access JWT -> via access, login = email claim", async () => {
    const { jwks, sign } = await makeAccessSigner();
    const { call } = await startTestServer({ jwks });
    const res = await call("/api/me", {
      identity: "none",
      headers: { "cf-access-jwt-assertion": await sign({ email: "boss@euidos.ai", name: "Boss" }) },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { login: "boss@euidos.ai", name: "Boss", via: "access" });
  });

  test("the Access JWT wins over tailnet headers on the same request", async () => {
    const { jwks, sign } = await makeAccessSigner();
    const { call } = await startTestServer({ jwks });
    const res = await call("/api/me", {
      headers: { "cf-access-jwt-assertion": await sign({ email: "boss@euidos.ai" }) },
    });
    assert.equal((await res.json()).via, "access");
  });

  test("wrong aud, wrong issuer, bad signature and expiry are all rejected", async () => {
    const { jwks, sign } = await makeAccessSigner();
    const other = await makeAccessSigner({ kid: "other-key" });
    const { call } = await startTestServer({ jwks });
    const cases = [
      await sign({}, { audience: "not-our-aud" }),
      await sign({}, { issuer: "https://evil.cloudflareaccess.com" }),
      await other.sign({}),
      "not.a.jwt",
    ];
    for (const token of cases) {
      const res = await call("/api/me", {
        identity: "none",
        headers: { "cf-access-jwt-assertion": token },
      });
      assert.equal(res.status, 401, token.slice(0, 24));
    }
    // sanity: the same helper with the right aud does pass
    const ok = await call("/api/me", {
      identity: "none",
      headers: { "cf-access-jwt-assertion": await sign({}, { audience: AUD }) },
    });
    assert.equal(ok.status, 200);
  });
});
