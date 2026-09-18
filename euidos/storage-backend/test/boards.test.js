import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { startTestServer } from "./helpers.js";

const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("boards", () => {
  test("create, list, rename, soft delete, ordering", async () => {
    const { call } = await startTestServer();

    const created = await call("/api/boards", json({ id: "board1", roomKey: "key1", name: "One" }));
    assert.equal(created.status, 201);
    const board = await created.json();
    assert.equal(board.id, "board1");
    assert.equal(board.roomKey, "key1");
    assert.equal(board.createdBy, "staff@euidos.ai");
    assert.equal(board.updatedBy, "staff@euidos.ai");
    assert.equal(board.elementCount, 0);

    const dup = await call("/api/boards", json({ id: "board1", roomKey: "key1", name: "One" }));
    assert.equal(dup.status, 409);

    await call("/api/boards", json({ id: "board2", roomKey: "key2", name: "Two" }));
    // board1 gets the newest edit
    await call("/api/rooms/board1", {
      ...json({ elements: [{ id: "a" }, { id: "b" }] }),
      method: "PUT",
    });

    const list = await (await call("/api/boards")).json();
    assert.deepEqual(
      list.boards.map((b) => b.id),
      ["board1", "board2"],
      "newest edit first",
    );
    assert.equal(list.boards[0].elementCount, 2);

    const renamed = await call("/api/boards/board2", {
      ...json({ name: "  Renamed  " }),
      method: "PATCH",
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).name, "Renamed");

    const del = await call("/api/boards/board2", { method: "DELETE" });
    assert.equal(del.status, 204);
    const after = await (await call("/api/boards")).json();
    assert.deepEqual(
      after.boards.map((b) => b.id),
      ["board1"],
      "soft-deleted boards are invisible",
    );

    // a deleted board's room and rename 404
    assert.equal((await call("/api/rooms/board2")).status, 404);
    assert.equal(
      (await call("/api/boards/board2", { ...json({ name: "x" }), method: "PATCH" })).status,
      404,
    );
    assert.equal((await call("/api/boards/nosuch", { method: "DELETE" })).status, 404);
  });

  test("bad payloads are rejected", async () => {
    const { call } = await startTestServer();
    assert.equal((await call("/api/boards", json({ roomKey: "k", name: "n" }))).status, 400);
    assert.equal((await call("/api/boards", json({ id: "a b", name: "n" }))).status, 400);
    assert.equal((await call("/api/boards", json({ id: "ok1", name: "   " }))).status, 400);
    const bad = await call("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "bad_request");
  });

  test("a wrong method on a known path is 405", async () => {
    const { call } = await startTestServer();
    assert.equal((await call("/api/boards", { method: "DELETE" })).status, 405);
  });
});
