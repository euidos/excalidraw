import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { startTestServer } from "./helpers.js";

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

  test("login listener + X-authentik-email -> via login, name from X-authentik-name", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/me", {
      identity: "login",
      headers: { "x-authentik-email": "boss@euidos.ai", "x-authentik-name": "Boss" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { login: "boss@euidos.ai", name: "Boss", via: "login" });
  });

  test("login listener without a name falls back to the email", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/me", { identity: "login" });
    assert.deepEqual(await res.json(), {
      login: "staff@euidos.ai",
      name: "staff@euidos.ai",
      via: "login",
    });
  });

  test("login listener without an email -> 401, even with tailnet headers", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/me", {
      identity: "none",
      headers: { "x-euidos-listener": "login", "tailscale-user-login": "spoof@euidos.ai" },
    });
    assert.equal(res.status, 401);
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

  test("X-authentik-* on the tailnet listener is ignored", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/me", {
      identity: "wall",
      headers: { "x-authentik-email": "spoof@euidos.ai", "x-authentik-name": "Spoof" },
    });
    assert.deepEqual(await res.json(), { login: "wall", name: "Wall", via: "wall" });
  });

  test("an unknown listener marker is untrusted -> 401", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/me", {
      identity: "none",
      headers: {
        "x-euidos-listener": "tunnel",
        "tailscale-user-login": "spoof@euidos.ai",
        "x-authentik-email": "spoof@euidos.ai",
      },
    });
    assert.equal(res.status, 401);
  });
});
