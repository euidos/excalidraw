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
    const res = await call("/api/rooms/room1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    });
    assert.equal(res.status, 413);
  });

  test("elements must be an array", async () => {
    const { call } = await startTestServer();
    assert.equal((await call("/api/rooms/room1", put({ elements: "nope" }))).status, 400);
    assert.equal((await call("/api/rooms/room1", put({}))).status, 400);
  });
  test("baseVersion guards the client's read-modify-write (lost update)", async () => {
    const { call } = await startTestServer();

    // v1: the scene exists
    await call("/api/rooms/race", put({ elements: [{ id: "base" }] }));

    // two clients both read version 1 and both merge onto it
    const a = await (await call("/api/rooms/race")).json();
    const b = await (await call("/api/rooms/race")).json();
    assert.equal(a.version, 1);
    assert.equal(b.version, 1);

    const first = await call(
      "/api/rooms/race",
      put({ elements: [{ id: "base" }, { id: "rectA" }], baseVersion: a.version }),
    );
    assert.equal(first.status, 200);
    assert.equal((await first.json()).version, 2);

    const second = await call(
      "/api/rooms/race",
      put({ elements: [{ id: "base" }, { id: "rectB" }], baseVersion: b.version }),
    );
    assert.equal(second.status, 409, "the stale writer must be refused, not silently win");
    assert.equal((await second.json()).error, "conflict");

    // rectA survived
    const stored = await (await call("/api/rooms/race")).json();
    assert.deepEqual(
      stored.elements.map((e) => e.id),
      ["base", "rectA"],
    );
    assert.equal(stored.version, 2);

    // the retry (re-read, re-merge, re-PUT) succeeds
    const retried = await call(
      "/api/rooms/race",
      put({ elements: [{ id: "base" }, { id: "rectA" }, { id: "rectB" }], baseVersion: 2 }),
    );
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).version, 3);
  });

  test("baseVersion 0 means 'the room did not exist yet'", async () => {
    const { call } = await startTestServer();
    const created = await call("/api/rooms/fresh", put({ elements: [], baseVersion: 0 }));
    assert.equal(created.status, 200);
    // the same first-write attempt from a second client is now a conflict
    const late = await call("/api/rooms/fresh", put({ elements: [{ id: "x" }], baseVersion: 0 }));
    assert.equal(late.status, 409);
  });

  test("a bad baseVersion is a 400", async () => {
    const { call } = await startTestServer();
    assert.equal((await call("/api/rooms/bv", put({ elements: [], baseVersion: -1 }))).status, 400);
    assert.equal(
      (await call("/api/rooms/bv", put({ elements: [], baseVersion: "1" }))).status,
      400,
    );
  });

  test("a scene carrying a NUL character is saveable (jsonb could not)", async () => {
    const { call } = await startTestServer();
    const text = `a${String.fromCharCode(0)}b`;
    const res = await call("/api/rooms/nulroom", put({ elements: [{ id: "t", type: "text", text }] }));
    assert.equal(res.status, 200, "a pasted U+0000 must not brick the board");

    const got = await (await call("/api/rooms/nulroom")).json();
    assert.equal(got.elements[0].text, text);

    // and the board still lists (element_count runs over the same document)
    const list = await (await call("/api/boards")).json();
    assert.equal(list.boards[0].elementCount, 1);
  });

  test("elementCount counts live elements, not tombstones", async () => {
    const { call } = await startTestServer();
    await call(
      "/api/rooms/tomb",
      put({
        elements: [
          { id: "a", isDeleted: false },
          { id: "b", isDeleted: true },
          { id: "c" },
        ],
      }),
    );
    const list = await (await call("/api/boards")).json();
    assert.equal(list.boards[0].elementCount, 2);
  });
});
