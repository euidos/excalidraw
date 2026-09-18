import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import assertNode from "node:assert";
import test, { describe } from "node:test";

import { startTestServer } from "./helpers.js";

describe("files and scene blobs", () => {
  test("file roundtrip keeps bytes and content type", async () => {
    const { call } = await startTestServer();
    const bytes = randomBytes(4096);

    assert.equal((await call("/api/files/file1")).status, 404);

    const put = await call("/api/files/file1?board=board1", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: bytes,
    });
    assert.equal(put.status, 201);

    const got = await call("/api/files/file1");
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/png");
    assertNode.deepStrictEqual(Buffer.from(await got.arrayBuffer()), bytes);
  });

  test("a file over MAX_FILE_BYTES (4 MiB) is 413", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/files/big", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: Buffer.alloc(5 * 1024 * 1024, 1),
    });
    assert.equal(res.status, 413);
    assert.equal((await call("/api/files/big")).status, 404);
  });

  test("an empty file body is 400", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/files/empty", { method: "PUT", body: "" });
    assert.equal(res.status, 400);
  });

  test("/api/v2/scenes roundtrips an opaque blob", async () => {
    const { call } = await startTestServer();
    const payload = randomBytes(2048);
    const posted = await call("/api/v2/scenes", { method: "POST", body: payload });
    assert.equal(posted.status, 201);
    const { id } = await posted.json();
    assert.match(id, /^[0-9a-f]{32}$/);

    const got = await call(`/api/v2/scenes/${id}`);
    assert.equal(got.status, 200);
    assertNode.deepStrictEqual(Buffer.from(await got.arrayBuffer()), payload);
    assert.equal((await call("/api/v2/scenes/deadbeef")).status, 404);
  });

  test("scene blobs need an identity too", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/v2/scenes", { method: "POST", body: "x", identity: "none" });
    assert.equal(res.status, 401);
  });
});
