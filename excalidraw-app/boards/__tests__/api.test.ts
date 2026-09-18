/**
 * `boards/api.ts` against a mocked `fetch`.
 *
 * What is worth pinning here is exactly what a real backend would punish and a
 * screenshot would not show: the headers the CSRF/415 guards demand, and the
 * mapping from status code to a TYPE the UI branches on. The phase-1 RETRO's L2
 * ("verified against a mocked fetch is not verified against the backend") is why
 * the same routes are also driven for real by euidos/e2e/boards.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EuidosSessionError, isSessionError } from "../../data/euidosStorage";
import {
  BoardsApiError,
  BoardsConflictError,
  BoardsForbiddenError,
  BoardsNotFoundError,
  BoardsTooLargeError,
  createBoard,
  deleteBoard,
  fetchBoards,
  fetchIdentity,
  renameBoard,
} from "../api";

const ORIGIN = window.location.origin;

const response = (status: number, body: unknown) =>
  ({
    ok: status < 400,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response);

const board = (overrides: Record<string, unknown> = {}) => ({
  id: "board1",
  name: "Board one",
  roomKey: "sTdLvpwRhVXVstXJLsGCOA",
  createdBy: "alice@euidos.ai",
  createdAt: "2026-09-18T09:00:00.000Z",
  updatedBy: "bob@euidos.ai",
  updatedAt: "2026-09-18T09:30:00.000Z",
  elementCount: 3,
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

const lastCall = () => fetchMock.mock.calls[0] as [string, RequestInit];

describe("request shape", () => {
  it("GETs from the current origin's /api, same-origin credentials, no body and NO content type", async () => {
    fetchMock.mockResolvedValue(response(200, { boards: [] }));

    await fetchBoards();

    const [url, init] = lastCall();
    expect(url).toBe(`${ORIGIN}/api/boards`);
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBeUndefined();
    // a GET that declared application/json would be a lie, and the backend's
    // 415 guard only applies to bodies anyway
    expect(init.headers).toBeUndefined();
  });

  it("sends Content-Type: application/json on every request that carries a body (or the backend answers 415)", async () => {
    fetchMock.mockResolvedValue(response(201, board()));

    await createBoard({ id: "board1", roomKey: "key", name: "Board one" });

    const [url, init] = lastCall();
    expect(url).toBe(`${ORIGIN}/api/boards`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      id: "board1",
      roomKey: "key",
      name: "Board one",
    });
  });

  it("PATCHes only the name, percent-encoding the id into the path", async () => {
    fetchMock.mockResolvedValue(response(200, board({ name: "Renamed" })));

    const updated = await renameBoard("a b/c", "Renamed");

    const [url, init] = lastCall();
    expect(url).toBe(`${ORIGIN}/api/boards/a%20b%2Fc`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Renamed" });
    expect(updated.name).toBe("Renamed");
  });

  it("DELETEs without a body and tolerates the 204 (no JSON to parse)", async () => {
    fetchMock.mockResolvedValue(response(204, undefined));

    await expect(deleteBoard("board1")).resolves.toBeUndefined();

    const [url, init] = lastCall();
    expect(url).toBe(`${ORIGIN}/api/boards/board1`);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("unwraps {boards:[…]} and survives a malformed payload without throwing", async () => {
    fetchMock.mockResolvedValue(response(200, { boards: [board()] }));
    expect(await fetchBoards()).toHaveLength(1);

    fetchMock.mockResolvedValue(response(200, { nope: true }));
    expect(await fetchBoards()).toEqual([]);
  });

  it("reads /api/me", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        login: "alice@euidos.ai",
        name: "Alice",
        via: "tailnet",
      }),
    );

    expect(await fetchIdentity()).toEqual({
      login: "alice@euidos.ai",
      name: "Alice",
      via: "tailnet",
    });
    expect(lastCall()[0]).toBe(`${ORIGIN}/api/me`);
  });
});

describe("error mapping", () => {
  it("401 is a SESSION error, recognised by the same isSessionError() the save path uses", async () => {
    fetchMock.mockResolvedValue(
      response(401, { error: "unauthorized", message: "No identity" }),
    );

    const error = await fetchBoards().catch((err) => err);
    expect(error).toBeInstanceOf(EuidosSessionError);
    expect(isSessionError(error)).toBe(true);
  });

  it("403 is NOT a session error — the wall gets it on rename/delete and reloading changes nothing", async () => {
    fetchMock.mockResolvedValue(
      response(403, {
        error: "forbidden",
        message: "Sign in on a personal device to rename a board",
      }),
    );

    const error = await renameBoard("board1", "x").catch((err) => err);
    expect(error).toBeInstanceOf(BoardsForbiddenError);
    expect(isSessionError(error)).toBe(false);
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "Sign in on a personal device to rename a board",
    );
  });

  it("404 / 409 / 413 each get their own type", async () => {
    fetchMock.mockResolvedValue(response(404, { error: "not_found" }));
    await expect(deleteBoard("gone")).rejects.toBeInstanceOf(
      BoardsNotFoundError,
    );

    fetchMock.mockResolvedValue(
      response(409, { error: "conflict", message: "taken" }),
    );
    await expect(
      createBoard({ id: "board1", roomKey: "k", name: "n" }),
    ).rejects.toBeInstanceOf(BoardsConflictError);

    fetchMock.mockResolvedValue(
      response(413, {
        error: "too_large",
        error_class: "RequestTooLargeError",
      }),
    );
    await expect(
      createBoard({ id: "board1", roomKey: "k", name: "n" }),
    ).rejects.toBeInstanceOf(BoardsTooLargeError);
  });

  it("any other status is a BoardsApiError carrying the backend's code and message", async () => {
    fetchMock.mockResolvedValue(
      response(500, { error: "server_error", message: "boom" }),
    );

    const error = await fetchBoards().catch((err) => err);
    expect(error).toBeInstanceOf(BoardsApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe("server_error");
    expect(error.message).toBe("boom");
  });

  it("a non-JSON error body still produces a typed error, not a parse crash", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "<html>bad gateway</html>",
    } as unknown as Response);

    const error = await fetchBoards().catch((err) => err);
    expect(error).toBeInstanceOf(BoardsApiError);
    expect(error.message).toBe("Request failed (502)");
  });

  it("a rejected fetch (Access redirect / origin down) is the session error, not a silent failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await fetchBoards().catch((err) => err);
    expect(isSessionError(error)).toBe(true);
  });
});
