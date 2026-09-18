// Regressions for the phase-1 security review. Every test here fails against
// the pre-review service.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { describe } from "node:test";

import { startTestServer } from "./helpers.js";

const json = (method, body) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("stored files can never be a page (stored XSS)", () => {
  test("a hostile content type is stored and served as a binary download", async () => {
    const { call } = await startTestServer();
    const put = await call("/api/files/evil1?board=b1", {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: "<script>alert(document.domain)</script>",
    });
    assert.equal(put.status, 201);

    const got = await call("/api/files/evil1");
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "application/octet-stream");
    assert.equal(got.headers.get("content-disposition"), "attachment");
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.match(got.headers.get("content-security-policy"), /default-src 'none'/);
  });

  test("image/svg+xml and application/javascript are coerced too", async () => {
    const { call } = await startTestServer();
    for (const [id, type] of [
      ["svg1", "image/svg+xml"],
      ["js1", "application/javascript"],
      ["html2", "text/html; charset=utf-8"],
    ]) {
      await call(`/api/files/${id}`, {
        method: "PUT",
        headers: { "content-type": type },
        body: "x",
      });
      const got = await call(`/api/files/${id}`);
      assert.equal(got.headers.get("content-type"), "application/octet-stream", type);
    }
  });

  test("an allowlisted image type still previews", async () => {
    const { call } = await startTestServer();
    await call("/api/files/png1", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: randomBytes(16),
    });
    const got = await call("/api/files/png1");
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.equal(got.headers.get("content-disposition"), "attachment");
  });

  test("share-link blobs carry the same guards", async () => {
    const { call } = await startTestServer();
    const posted = await call("/api/v2/scenes", { method: "POST", body: "blob" });
    const { id } = await posted.json();
    const got = await call(`/api/v2/scenes/${id}`);
    assert.equal(got.headers.get("content-disposition"), "attachment");
    assert.equal(got.headers.get("content-type"), "application/octet-stream");
  });
});

describe("CSRF: ambient identity must not be usable cross-site", () => {
  test("a cross-site state-changing request is 403", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/boards", {
      ...json("POST", { id: "csrf1", name: "x" }),
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "forbidden");
    assert.equal((await (await call("/api/boards")).json()).boards.length, 0);
  });

  test("a foreign Origin is 403 even without Sec-Fetch-*", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/rooms/csrf2", {
      ...json("PUT", { elements: [] }),
      headers: { "content-type": "application/json", origin: "https://evil.example" },
    });
    assert.equal(res.status, 403);
  });

  test("same-origin and same-origin-ish requests still pass", async () => {
    const { base, call } = await startTestServer();
    const ok = await call("/api/boards", {
      ...json("POST", { id: "csrf3", name: "x" }),
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        origin: base,
      },
    });
    assert.equal(ok.status, 201);
  });

  test("reads are never blocked (no identity is granted by a read)", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/boards", { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(res.status, 200);
  });

  test("a form-shaped body (text/plain) on a JSON route is 415", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/boards", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ id: "csrf4", name: "x" }),
    });
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error, "unsupported_media_type");
  });
});

describe("the wall is a display, not an administrator", () => {
  test("it may save its own room but not delete or rename boards", async () => {
    const { call } = await startTestServer();
    await call("/api/boards", json("POST", { id: "owned", name: "Owned" }));

    const saved = await call("/api/rooms/owned", {
      ...json("PUT", { elements: [{ id: "a" }] }),
      identity: "wall",
    });
    assert.equal(saved.status, 200, "the wall must still be able to save");

    const del = await call("/api/boards/owned", { method: "DELETE", identity: "wall" });
    assert.equal(del.status, 403);
    const patch = await call("/api/boards/owned", {
      ...json("PATCH", { name: "hijacked" }),
      identity: "wall",
    });
    assert.equal(patch.status, 403);

    const list = await (await call("/api/boards")).json();
    assert.equal(list.boards.length, 1);
    assert.equal(list.boards[0].name, "Owned");

    // a signed-in person still can
    assert.equal((await call("/api/boards/owned", { method: "DELETE" })).status, 204);
  });
});

describe("router hygiene", () => {
  test("a URI-malformed id is 400, not 500", async () => {
    const { call } = await startTestServer();
    for (const path of [
      "/api/rooms/%E0%A4",
      "/api/boards/%C0%80",
      "/api/files/%E0%A4",
      "/api/v2/scenes/%E0%A4",
    ]) {
      const res = await call(path, path.startsWith("/api/boards") ? { method: "DELETE" } : {});
      assert.equal(res.status, 400, path);
      assert.equal((await res.json()).error, "bad_request", path);
    }
  });

  test("HEAD is answered like GET (uptime probes)", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/health", { method: "HEAD", identity: "none" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
    assert.equal((await call("/api/boards", { method: "HEAD" })).status, 200);
  });
});

describe("share links report an oversized scene as such", () => {
  test("POST /api/v2/scenes 413 carries upstream's error_class", async () => {
    const { call } = await startTestServer({ env: { MAX_SCENE_BYTES: "1024" } });
    const res = await call("/api/v2/scenes", {
      method: "POST",
      body: Buffer.alloc(2048, 1),
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error_class, "RequestTooLargeError");
  });
});
