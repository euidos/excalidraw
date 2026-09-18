import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// euidos boards storage — replaces `data/firebase.ts`.
// -----------------------------------------------------------------------------
// Why the Firebase names are kept verbatim (`isSavedToFirebase`,
// `saveToFirebase`, `loadFromFirebase`, `saveFilesToFirebase`,
// `loadFilesFromFirebase`): every call site upstream (Collab.tsx, App.tsx,
// data/index.ts) then changes by its *import line only*, so merging new
// upstream revisions of those files stays a one-line conflict instead of a
// semantic one. `data/firebase.ts` is left in the tree untouched for the same
// reason — nothing imports it any more, so it is not bundled.
//
// Differences from the Firebase implementation, all deliberate:
//   * scenes are stored as plaintext JSON at `PUT/GET /api/rooms/:roomId`.
//     Boards are server-readable by design (staff login at the edge is the
//     privacy boundary); the room key still encrypts the socket relay because
//     that code is untouched.
//   * Firebase reconciled inside a Firestore transaction. Our backend stores
//     the scene as given, so `saveToFirebase` does the read-modify-write here:
//     GET the stored scene, `reconcileElements`, PUT the result — and the PUT
//     carries `baseVersion`, the version it merged against. The backend refuses
//     a stale write with 409, we re-read and re-merge, up to
//     `MAX_SAVE_ATTEMPTS`. That is what Firestore's `runTransaction` did; plain
//     last-writer-wins silently deleted the other writer's elements.
//   * files keep their upstream envelope (compressed + encrypted with the room
//     key by `encodeFilesForUpload`) and travel as raw bytes over
//     `PUT /api/files/:id?board=<boardId>` / `GET /api/files/:id`. Because that
//     envelope is keyed per room, the same image in two boards would otherwise
//     collide on the (global) file id, so the stored id is
//     `<boardId>_<fileId>` — see `fileStorageId`.
// -----------------------------------------------------------------------------

/** matches the backend's scene size limit (contract: PUT /api/rooms/:id) */
const SCENE_MAX_BYTES = 20 * 1024 * 1024;

/** GET -> reconcile -> PUT attempts before a concurrent writer is given up on */
const MAX_SAVE_ATTEMPTS = 5;

/**
 * Thrown when the edge refused the request rather than the backend: on
 * board.euidos.ai a Cloudflare Access session expires, and from then on every
 * save fails. That is not a transient blip — the user must reload to sign in —
 * so Collab.tsx tells them so instead of showing the generic save error once and
 * letting them keep drawing into a board that is no longer being persisted.
 */
export class EuidosSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EuidosSessionError";
  }
}

export const isSessionError = (error: unknown): boolean =>
  error instanceof Error && error.name === "EuidosSessionError";

const SESSION_ERROR_MESSAGE =
  "euidos storage: your session expired or the server is unreachable — reload this page to sign in again";

/**
 * Every call to our own origin goes through here so that an expired Access
 * session is always the same, recognisable error. A `fetch` rejection on a
 * same-origin /api path is either the Access login redirect failing the CORS
 * check or the origin being down; both are fixed by reloading.
 */
const apiFetch = async (path: string, init?: RequestInit) => {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      credentials: "same-origin",
      ...init,
    });
  } catch (error: any) {
    throw new EuidosSessionError(SESSION_ERROR_MESSAGE);
  }
  if (response.status === 401 || response.status === 403) {
    throw new EuidosSessionError(SESSION_ERROR_MESSAGE);
  }
  return response;
};

/**
 * One static build serves both the tunnel and the tailnet origin, so the API
 * base is derived at call time and never baked in.
 */
const apiUrl = (path: string) => `${window.location.origin}/api${path}`;

/**
 * The upstream callers address files by a storage *prefix*
 * (`/files/rooms/<roomId>`, `/files/shareLinks/<sceneId>`); the last segment is
 * the owning board (or share-link scene) id.
 */
const boardIdFromPrefix = (prefix: string) =>
  prefix.replace(/\/+$/, "").split("/").pop() || "";

const fileStorageId = (boardId: string, fileId: FileId | string) =>
  encodeURIComponent(`${boardId}_${fileId}`);

/**
 * Scene version we last wrote to (or read from) the backend. Keyed by SOCKET,
 * as upstream's firebase.ts was: a cache that outlives the connection also
 * outlives the proof that the save landed, so after a reconnect the client
 * would never re-send a scene that a concurrent writer had meanwhile dropped.
 * A fresh socket starts with an empty cache, so the first save after any
 * (re)connect always goes through.
 */
class SavedSceneVersionCache {
  private static cache = new WeakMap<SocketLike, number>();

  static get = (socket: SocketLike) => SavedSceneVersionCache.cache.get(socket);

  static set = (
    socket: SocketLike,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SavedSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };

  /** test seam */
  static clear = () => {
    SavedSceneVersionCache.cache = new WeakMap<SocketLike, number>();
  };
}

type SocketLike = object;

export const clearSavedSceneVersionCache = SavedSceneVersionCache.clear;

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    return (
      SavedSceneVersionCache.get(portal.socket) === getSceneVersion(elements)
    );
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

/** the stored scene and the version to send back as `baseVersion` */
type StoredScene = {
  elements: SyncableExcalidrawElement[];
  version: number;
};

const loadStoredScene = async (
  roomId: string,
  opts?: { deleteInvisibleElements?: boolean },
): Promise<StoredScene | null> => {
  const response = await apiFetch(`/rooms/${encodeURIComponent(roomId)}`);

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `euidos storage: could not load room ${roomId} (HTTP ${response.status})`,
    );
  }

  const stored = (await response.json()) as {
    elements?: readonly ExcalidrawElement[] | null;
    version?: number;
  };

  return {
    elements: getSyncableElements(
      restoreElements(stored.elements || [], null, {
        deleteInvisibleElements: opts?.deleteInvisibleElements ?? false,
      }),
    ),
    version: typeof stored.version === "number" ? stored.version : 0,
  };
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  // read -> reconcile -> write, retried while another writer commits in
  // between: the 409 is the backend refusing to let us overwrite a version we
  // never saw (see MAX_SAVE_ATTEMPTS).
  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
    const stored = await loadStoredScene(roomId);

    const nextElements = stored
      ? getSyncableElements(
          reconcileElements(
            elements,
            stored.elements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
            appState,
          ),
        )
      : elements;

    if (!stored && nextElements.length === 0) {
      // A "#room=" link that was opened and never drawn on. Writing an empty
      // scene would make the backend mint an "Untitled" board whose roomKey it
      // cannot know (the key never leaves the URL fragment), i.e. a board row
      // no one can ever open again. Treat it as saved and write nothing.
      SavedSceneVersionCache.set(socket, nextElements);
      return null;
    }

    const response = await apiFetch(`/rooms/${encodeURIComponent(roomId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        elements: nextElements,
        baseVersion: stored ? stored.version : 0,
      }),
    });

    if (response.status === 409) {
      continue;
    }
    if (response.status === 413) {
      // message shape kept compatible with Collab.tsx's size-error detection
      throw new Error(
        `euidos storage: scene is longer than ${SCENE_MAX_BYTES} bytes`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `euidos storage: could not save room ${roomId} (HTTP ${response.status})`,
      );
    }

    SavedSceneVersionCache.set(socket, nextElements);

    return toBrandedType<RemoteExcalidrawElement[]>(
      nextElements as unknown as RemoteExcalidrawElement[],
    );
  }

  throw new Error(
    `euidos storage: could not save room ${roomId} (the scene kept changing under ${MAX_SAVE_ATTEMPTS} attempts)`,
  );
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const stored = await loadStoredScene(roomId, {
    deleteInvisibleElements: true,
  });

  if (!stored) {
    return null;
  }

  if (socket) {
    SavedSceneVersionCache.set(socket, stored.elements);
  }

  return stored.elements;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const boardId = boardIdFromPrefix(prefix);

  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(
          apiUrl(
            `/files/${fileStorageId(boardId, id)}?board=${encodeURIComponent(
              boardId,
            )}`,
          ),
          {
            method: "PUT",
            credentials: "same-origin",
            headers: { "Content-Type": MIME_TYPES.binary },
            body: buffer as BodyInit,
          },
        );
        if (response.ok) {
          savedFiles.push(id);
        } else {
          erroredFiles.push(id);
        }
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const boardId = boardIdFromPrefix(prefix);

  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(
          apiUrl(`/files/${fileStorageId(boardId, id)}`),
          { credentials: "same-origin" },
        );
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
