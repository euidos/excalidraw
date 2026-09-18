import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { getSceneVersion } from "@excalidraw/element";
import { vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";
import type { AppState, BinaryFileData } from "@excalidraw/excalidraw/types";

import { encodeFilesForUpload } from "./FileManager";

import {
  clearSavedSceneVersionCache,
  isSavedToFirebase,
  isSessionError,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "./euidosStorage";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";

const ROOM_ID = "roomid1234";
const ROOM_KEY = "sTdLvpwRhVXVstXJLsGCOA";
const ORIGIN = window.location.origin;

const appState = getDefaultAppState() as AppState;

/**
 * The saved-version cache is keyed by SOCKET (as upstream's firebase.ts was),
 * so a test that wants continuity must reuse one socket and a test about
 * reconnects makes a new one.
 */
let socket: { id: string };

const portal = (onSocket: { id: string } = socket): Portal =>
  ({
    socket: onSocket,
    roomId: ROOM_ID,
    roomKey: ROOM_KEY,
  } as unknown as Portal);

const element = ({
  version,
  ...opts
}: Parameters<typeof API.createElement>[0] & { version?: number } = {}) => {
  const el = API.createElement({ type: "rectangle", ...opts });
  return (version == null
    ? el
    : { ...el, version }) as unknown as SyncableExcalidrawElement;
};

/** the payload PUT /api/rooms/:id received, parsed */
const putBody = (call: [string, RequestInit]) =>
  JSON.parse(call[1].body as string);

const jsonResponse = (status: number, body: any) =>
  ({
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response);

const bytesResponse = (status: number, bytes?: Uint8Array) =>
  ({
    ok: status < 400,
    status,
    arrayBuffer: async () => {
      const copy = new Uint8Array(bytes!);
      return copy.buffer;
    },
  } as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  socket = { id: "socket-1" };
  clearSavedSceneVersionCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const calls = () => fetchMock.mock.calls as [string, RequestInit][];

describe("euidosStorage — scenes", () => {
  it("saves a new room over PUT /api/rooms/:id and then reports it saved", async () => {
    const elements = [element({ id: "el-1", x: 10 })];

    expect(isSavedToFirebase(portal(), elements)).toBe(false);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: "not_found" }))
      .mockResolvedValueOnce(jsonResponse(200, { version: 1 }));

    const stored = await saveToFirebase(portal(), elements, appState);

    expect(calls()[0][0]).toBe(`${ORIGIN}/api/rooms/${ROOM_ID}`);
    expect(calls()[1][0]).toBe(`${ORIGIN}/api/rooms/${ROOM_ID}`);
    expect(calls()[1][1].method).toBe("PUT");
    expect(putBody(calls()[1]).elements).toHaveLength(1);
    expect(putBody(calls()[1]).elements[0].id).toBe("el-1");
    // the room did not exist: base version 0
    expect(putBody(calls()[1]).baseVersion).toBe(0);
    // plaintext JSON — no ciphertext/iv envelope
    expect(putBody(calls()[1])).not.toHaveProperty("ciphertext");

    expect(stored).not.toBeNull();
    expect(isSavedToFirebase(portal(), elements)).toBe(true);
  });

  it("does not re-save an unchanged scene", async () => {
    const elements = [element({ id: "el-1" })];

    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, { version: 1 }));
    await saveToFirebase(portal(), elements, appState);
    expect(calls()).toHaveLength(2);

    expect(await saveToFirebase(portal(), elements, appState)).toBeNull();
    expect(calls()).toHaveLength(2);
  });

  it("reconciles against the stored scene before writing (newer remote wins)", async () => {
    const local = [element({ id: "el-1", x: 1, version: 1 })];
    const remote = [element({ id: "el-1", x: 999, version: 5 })];

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { elements: remote, version: 5 }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { version: 6 }));

    await saveToFirebase(portal(), local, appState);

    const written = putBody(calls()[1]).elements;
    expect(written).toHaveLength(1);
    expect(written[0].x).toBe(999);
    // and the merge is written back against the version it merged with
    expect(putBody(calls()[1]).baseVersion).toBe(5);
  });

  it("loads and restores a stored scene, and marks it saved", async () => {
    const remote = [element({ id: "el-1", x: 7 })];
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { elements: remote, version: 3 }),
    );

    const loaded = await loadFromFirebase(ROOM_ID, ROOM_KEY, socket as any);

    expect(loaded).toHaveLength(1);
    expect(loaded![0].id).toBe("el-1");
    // restoreElements bumps versions (as it did on the Firebase path), so the
    // cache must be keyed on what we actually handed back
    expect(getSceneVersion(loaded!)).toBeGreaterThanOrEqual(
      getSceneVersion(remote),
    );
    expect(isSavedToFirebase(portal(), loaded!)).toBe(true);
  });

  it("returns null for a room that was never saved (404)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "not_found" }));
    expect(await loadFromFirebase(ROOM_ID, ROOM_KEY, null)).toBeNull();
  });

  it("raises a size error Collab.tsx can recognise on 413", async () => {
    const elements = [element({ id: "el-1" })];
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(413, { error: "too_large" }));

    await expect(
      saveToFirebase(portal(), elements, appState),
    ).rejects.toThrowError(/is longer than.*?bytes/);

    // and the scene must not be considered saved
    expect(isSavedToFirebase(portal(), elements)).toBe(false);
  });

  it("raises on any other save failure", async () => {
    const elements = [element({ id: "el-1" })];
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));

    await expect(
      saveToFirebase(portal(), elements, appState),
    ).rejects.toThrowError(/HTTP 500/);
  });

  it("retries a save the backend refused as stale (no lost update)", async () => {
    const local = [element({ id: "mine", x: 1, version: 3 })];

    fetchMock
      // read at version 1 ...
      .mockResolvedValueOnce(jsonResponse(200, { elements: [], version: 1 }))
      // ... someone else committed version 2 in between
      .mockResolvedValueOnce(jsonResponse(409, { error: "conflict" }))
      // re-read, re-merge against what they wrote ...
      .mockResolvedValueOnce(
        jsonResponse(200, {
          elements: [element({ id: "theirs", x: 5, version: 9 })],
          version: 2,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { version: 3 }));

    const stored = await saveToFirebase(portal(), local, appState);

    expect(calls()).toHaveLength(4);
    expect(putBody(calls()[1]).baseVersion).toBe(1);
    expect(putBody(calls()[3]).baseVersion).toBe(2);
    // both writers' elements survive the retry
    const written = putBody(calls()[3])
      .elements.map((el: any) => el.id)
      .sort();
    expect(written).toEqual(["mine", "theirs"]);
    expect(stored).not.toBeNull();
    expect(isSavedToFirebase(portal(), local)).toBe(false);
  });

  it("re-reads the LIVE scene before a retry instead of re-merging the stale snapshot", async () => {
    // The voice tool rewrites one element IN PLACE: the interim preview and the final transcript share an id, and
    // only `text`/`opacity`/`customData` change. So "the snapshot the save began with" and "what the canvas shows
    // now" can be the same element in two different states, and a 409 decides which one is persisted.
    const preview = [
      element({ id: "words", x: 1, version: 3, opacity: 45 }),
    ] as any[];
    const committed = [
      element({ id: "words", x: 1, version: 4, opacity: 100 }),
    ] as any[];

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { elements: [], version: 1 }))
      .mockResolvedValueOnce(jsonResponse(409, { error: "conflict" }))
      .mockResolvedValueOnce(jsonResponse(200, { elements: [], version: 2 }))
      .mockResolvedValueOnce(jsonResponse(200, { version: 3 }));

    await saveToFirebase(
      portal(),
      preview as SyncableExcalidrawElement[],
      appState,
      () => committed as SyncableExcalidrawElement[],
    );

    expect(putBody(calls()[1]).elements[0].opacity).toBe(45);
    // The retry must carry the words as they are NOW, not the preview the save set out with.
    expect(putBody(calls()[3]).elements[0].opacity).toBe(100);
  });

  it("still works for a caller that passes no live-scene reader", async () => {
    const local = [element({ id: "mine", x: 1, version: 3 })];
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { elements: [], version: 1 }))
      .mockResolvedValueOnce(jsonResponse(409, { error: "conflict" }))
      .mockResolvedValueOnce(jsonResponse(200, { elements: [], version: 2 }))
      .mockResolvedValueOnce(jsonResponse(200, { version: 3 }));

    await saveToFirebase(portal(), local, appState);

    expect(putBody(calls()[3]).elements[0].id).toBe("mine");
  });

  it("gives up after repeated conflicts instead of looping forever", async () => {
    const local = [element({ id: "el-1" })];
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? jsonResponse(409, { error: "conflict" })
        : jsonResponse(200, { elements: [], version: 1 }),
    );

    await expect(
      saveToFirebase(portal(), local, appState),
    ).rejects.toThrowError(/kept changing/);
    // 5 attempts, each a GET + a PUT
    expect(calls()).toHaveLength(10);
  });

  it("does not create a board for a room that was opened and never drawn on", async () => {
    // GET 404 (never saved) and nothing to save -> no PUT at all, so the
    // backend never mints an 'Untitled' board with an unknowable roomKey
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "not_found" }));

    expect(await saveToFirebase(portal(), [], appState)).toBeNull();

    expect(calls()).toHaveLength(1);
    expect(calls()[0][1]?.method).toBeUndefined();
    expect(isSavedToFirebase(portal(), [])).toBe(true);
  });

  it("still writes an empty scene once the room exists (a cleared board)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { elements: [element({ id: "gone" })], version: 2 }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { version: 3 }));

    await saveToFirebase(portal(), [], appState);

    expect(calls()).toHaveLength(2);
    expect(calls()[1][1].method).toBe("PUT");
  });

  it("forgets the saved version on a new socket, so a reconnect re-saves", async () => {
    const elements = [element({ id: "el-1" })];

    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, { version: 1 }));
    await saveToFirebase(portal(), elements, appState);
    expect(isSavedToFirebase(portal(), elements)).toBe(true);

    // the connection dropped and came back: whatever we proved about the
    // stored scene belonged to the old socket
    const reconnected = { id: "socket-2" };
    expect(isSavedToFirebase(portal(reconnected), elements)).toBe(false);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { elements: [], version: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, { version: 2 }));
    await saveToFirebase(portal(reconnected), elements, appState);
    expect(calls()).toHaveLength(4);
  });

  it("marks a 401/403 as a session error Collab can act on", async () => {
    const elements = [element({ id: "el-1" })];

    for (const status of [401, 403]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(jsonResponse(status, { error: "x" }));
      const error = await saveToFirebase(portal(), elements, appState).catch(
        (e) => e,
      );
      expect(isSessionError(error)).toBe(true);
      expect(error.message).toMatch(/reload this page/i);
    }
  });

  it("marks an unreachable origin (the Access redirect) as a session error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const error = await saveToFirebase(
      portal(),
      [element({ id: "el-1" })],
      appState,
    ).catch((e) => e);
    expect(isSessionError(error)).toBe(true);
  });
});

describe("euidosStorage — files", () => {
  const fileId = "file-abc" as FileId;

  const encodedFile = async () => {
    const file: BinaryFileData = {
      id: fileId,
      mimeType: "image/png",
      dataURL:
        "data:image/png;base64,iVBORw0KGgo=" as BinaryFileData["dataURL"],
      created: Date.now(),
    };
    return (
      await encodeFilesForUpload({
        files: new Map([[fileId, file]]),
        encryptionKey: ROOM_KEY,
        maxBytes: 4 * 1024 * 1024,
      })
    )[0];
  };

  it("round-trips a file through PUT/GET /api/files/:id", async () => {
    const encoded = await encodedFile();

    fetchMock.mockResolvedValueOnce(jsonResponse(201, {}));
    const { savedFiles, erroredFiles } = await saveFilesToFirebase({
      prefix: `/files/rooms/${ROOM_ID}`,
      files: [encoded],
    });

    expect(savedFiles).toEqual([fileId]);
    expect(erroredFiles).toEqual([]);
    expect(calls()[0][0]).toBe(
      `${ORIGIN}/api/files/${ROOM_ID}_${fileId}?board=${ROOM_ID}`,
    );
    expect(calls()[0][1].method).toBe("PUT");
    expect(calls()[0][1].body).toBe(encoded.buffer);

    fetchMock.mockResolvedValueOnce(bytesResponse(200, encoded.buffer));
    const loaded = await loadFilesFromFirebase(
      `/files/rooms/${ROOM_ID}`,
      ROOM_KEY,
      [fileId],
    );

    expect(calls()[1][0]).toBe(`${ORIGIN}/api/files/${ROOM_ID}_${fileId}`);
    expect(loaded.erroredFiles.size).toBe(0);
    expect(loaded.loadedFiles).toHaveLength(1);
    expect(loaded.loadedFiles[0].id).toBe(fileId);
    expect(loaded.loadedFiles[0].mimeType).toBe("image/png");
    expect(loaded.loadedFiles[0].dataURL).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("namespaces stored files by board so two boards never collide", async () => {
    const encoded = await encodedFile();
    fetchMock.mockResolvedValue(jsonResponse(201, {}));

    await saveFilesToFirebase({
      prefix: `/files/rooms/other-room`,
      files: [encoded],
    });
    await saveFilesToFirebase({
      prefix: `/files/shareLinks/scene-9`,
      files: [encoded],
    });

    expect(calls()[0][0]).toBe(
      `${ORIGIN}/api/files/other-room_${fileId}?board=other-room`,
    );
    expect(calls()[1][0]).toBe(
      `${ORIGIN}/api/files/scene-9_${fileId}?board=scene-9`,
    );
  });

  it("reports an upload rejected by the backend as errored", async () => {
    const encoded = await encodedFile();
    fetchMock.mockResolvedValueOnce(jsonResponse(413, { error: "too_large" }));

    const { savedFiles, erroredFiles } = await saveFilesToFirebase({
      prefix: `/files/rooms/${ROOM_ID}`,
      files: [encoded],
    });

    expect(savedFiles).toEqual([]);
    expect(erroredFiles).toEqual([fileId]);
  });

  it("reports a missing file (404) as errored instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(bytesResponse(404));

    const loaded = await loadFilesFromFirebase(
      `/files/rooms/${ROOM_ID}`,
      ROOM_KEY,
      [fileId],
    );

    expect(loaded.loadedFiles).toEqual([]);
    expect(loaded.erroredFiles.get(fileId)).toBe(true);
  });
});
