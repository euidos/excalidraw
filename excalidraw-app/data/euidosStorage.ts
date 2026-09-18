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
//     GET the stored scene, `reconcileElements`, PUT the result. Last writer
//     wins on a true race; the socket relay + the 20 s full-scene resync heal
//     it, exactly as they did with the Firebase path.
//   * files keep their upstream envelope (compressed + encrypted with the room
//     key by `encodeFilesForUpload`) and travel as raw bytes over
//     `PUT /api/files/:id?board=<boardId>` / `GET /api/files/:id`. Because that
//     envelope is keyed per room, the same image in two boards would otherwise
//     collide on the (global) file id, so the stored id is
//     `<boardId>_<fileId>` — see `fileStorageId`.
// -----------------------------------------------------------------------------

/** matches the backend's scene size limit (contract: PUT /api/rooms/:id) */
const SCENE_MAX_BYTES = 20 * 1024 * 1024;

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
 * Scene version we last wrote to (or read from) the backend, per room. Keyed by
 * room rather than by socket so that it survives a reconnect: the version is a
 * property of the scene, not of the connection.
 */
class SavedSceneVersionCache {
  private static cache = new Map<string, number>();

  static get = (roomId: string) => SavedSceneVersionCache.cache.get(roomId);

  static set = (
    roomId: string,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SavedSceneVersionCache.cache.set(roomId, getSceneVersion(elements));
  };

  /** test seam */
  static clear = () => SavedSceneVersionCache.cache.clear();
}

export const clearSavedSceneVersionCache = SavedSceneVersionCache.clear;

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    return (
      SavedSceneVersionCache.get(portal.roomId) === getSceneVersion(elements)
    );
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

const loadStoredElements = async (
  roomId: string,
  opts?: { deleteInvisibleElements?: boolean },
): Promise<SyncableExcalidrawElement[] | null> => {
  const response = await fetch(apiUrl(`/rooms/${encodeURIComponent(roomId)}`), {
    credentials: "same-origin",
  });

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
  };

  return getSyncableElements(
    restoreElements(stored.elements || [], null, {
      deleteInvisibleElements: opts?.deleteInvisibleElements ?? false,
    }),
  );
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

  const prevStoredElements = await loadStoredElements(roomId);

  const nextElements = prevStoredElements
    ? getSyncableElements(
        reconcileElements(
          elements,
          prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      )
    : elements;

  const response = await fetch(apiUrl(`/rooms/${encodeURIComponent(roomId)}`), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ elements: nextElements }),
  });

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

  SavedSceneVersionCache.set(roomId, nextElements);

  return toBrandedType<RemoteExcalidrawElement[]>(
    nextElements as unknown as RemoteExcalidrawElement[],
  );
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const elements = await loadStoredElements(roomId, {
    deleteInvisibleElements: true,
  });

  if (!elements) {
    return null;
  }

  if (socket) {
    SavedSceneVersionCache.set(roomId, elements);
  }

  return elements;
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
