import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { startTestServer } from "./helpers.js";

const put = (body) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("rooms", () => {
  test("PUT creates an Untitled board, GET returns the scene, version increments", async () => {
    const { call } = await startTestServer();

    assert.equal((await call("/api/rooms/room1")).status, 404, "never saved");

    const first = await call("/api/rooms/room1", put({ elements: [{ id: "a" }] }));
    assert.equal(first.status, 200);
    const saved = await first.json();
    assert.equal(saved.version, 1);
    assert.ok(Date.parse(saved.updatedAt));

    const list = await (await call("/api/boards")).json();
    assert.equal(list.boards.length, 1);
    assert.equal(list.boards[0].name, "Untitled");
    assert.equal(list.boards[0].createdBy, "staff@euidos.ai");

    const second = await call("/api/rooms/room1", {
      ...put({ elements: [{ id: "a" }, { id: "b" }] }),
      headers: { "content-type": "application/json", "tailscale-user-login": "other@euidos.ai" },
    });
    assert.equal((await second.json()).version, 2);

    const got = await (await call("/api/rooms/room1")).json();
    assert.deepEqual(got.elements, [{ id: "a" }, { id: "b" }]);
    assert.equal(got.version, 2);

    const after = await (await call("/api/boards")).json();
    assert.equal(after.boards[0].updatedBy, "other@euidos.ai");
    assert.equal(after.boards[0].elementCount, 2);
  });

  test("the wall may save too", async () => {
    const { call } = await startTestServer();
    const res = await call("/api/rooms/wallroom", { ...put({ elements: [] }), identity: "wall" });
    assert.equal(res.status, 200);
    const list = await (await call("/api/boards")).json();
    assert.equal(list.boards[0].createdBy, "wall");
  });

  test("a scene over MAX_SCENE_BYTES (20 MiB) is 413", async () => {
    const { call } = await startTestServer();
    const huge = `{"elements":[{"id":"${"x".repeat(21 * 1024 * 1024)}"}]}`;
    const res = await call("/api/rooms/room1", put(huge));
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error, "too_large");
    // nothing was written
    assert.equal((await (await call("/api/boards")).json()).boards.length, 0);
  });

  test("the limit is enforced on a chunked body with no content-length", async () => {
    const { call } = await startTestServer({ env: { MAX_SCENE_BYTES: "1024" } });
    const chunk = new TextEncoder().encode("x".repeat(512));
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 8; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await call("/api/rooms/room1", { method: "PUT", body, duplex: "half" });
    assert.equal(res.status, 413);
  });

  test("elements must be an array", async () => {
    const { call } = await startTestServer();
    assert.equal((await call("/api/rooms/room1", put({ elements: "nope" }))).status, 400);
    assert.equal((await call("/api/rooms/room1", put({}))).status, 400);
  });
});
