/**
 * The boards index API — the typed half of `euidos/storage-backend`'s contract
 * that the boards page talks to (`/api/me`, `/api/boards`).
 *
 * The scene routes (`/api/rooms`, `/api/files`) are NOT here: they belong to
 * `data/euidosStorage.ts`, which upstream's collab code calls by the Firebase
 * names. The one thing the two share is the session error, imported rather than
 * redeclared so `isSessionError()` recognises a failure raised on either side.
 *
 * Three rules this file exists to keep (collab-plan phase 1 review, RETRO G-P3.4):
 *
 *   1. SAME ORIGIN. The API base is derived from `window.location.origin` at
 *      call time — one static build serves the tunnel and the tailnet name —
 *      and every request is `credentials: "same-origin"`. The backend refuses a
 *      state-changing request whose `Sec-Fetch-Site`/`Origin` is cross-site.
 *   2. `Content-Type: application/json` on every request that carries a body, or
 *      the backend answers 415. (`DELETE` sends no body and must not claim one.)
 *   3. Status codes become TYPES, not strings to grep: the boards page has to
 *      tell "the wall may not rename" (403) from "your session expired" (401)
 *      from "someone else took that id" (409). See `BoardsApiError` below.
 */
import { EuidosSessionError } from "../data/euidosStorage";

/** A row of `GET /api/boards`, exactly as the backend serialises it. */
export type Board = {
  id: string;
  name: string;
  /**
   * The room's encryption key, stored with the board so any staff member can
   * open it. `""` for rows auto-created by a save before phase 1 stored the key
   * (RETRO G-P3.2) — those can never get a working `#room=` link again, so the
   * UI must show them as link-less instead of handing out a broken URL.
   */
  roomKey: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  /** live (non-tombstoned) elements at the last save — a stored column, G-P3.3 */
  elementCount: number;
};

export type Via = "access" | "tailnet" | "wall";

/** `GET /api/me` — who the EDGE says we are; never a client-side claim. */
export type Identity = {
  login: string;
  name: string;
  via: Via;
};

/**
 * Any 4xx/5xx the backend answered with, carrying its `{error, message}` body.
 * Subclassed for the four statuses the boards UI branches on so call sites read
 * `instanceof BoardsForbiddenError`, not `err.status === 403`.
 */
export class BoardsApiError extends Error {
  readonly status: number;
  /** the backend's machine-readable `error` field, e.g. "forbidden" */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BoardsApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * 403. Two causes, both of which the UI must show rather than swallow: the wall
 * (`via:"wall"`) may not rename or delete (G-P3.1), and the CSRF guard refuses a
 * cross-site write (G-P3.4). It is NOT a session problem — a reload changes
 * nothing — which is why it is not folded into `EuidosSessionError`.
 */
export class BoardsForbiddenError extends BoardsApiError {
  constructor(message: string) {
    super(403, "forbidden", message);
    this.name = "BoardsForbiddenError";
  }
}

/** 404 — the board was deleted (or never existed) while this tab held it. */
export class BoardsNotFoundError extends BoardsApiError {
  constructor(message: string) {
    super(404, "not_found", message);
    this.name = "BoardsNotFoundError";
  }
}

/** 409 — the id is taken (a create), or a scene write raced (rooms). */
export class BoardsConflictError extends BoardsApiError {
  constructor(message: string) {
    super(409, "conflict", message);
    this.name = "BoardsConflictError";
  }
}

/** 413 — over `MAX_SCENE_BYTES`/`MAX_FILE_BYTES`. */
export class BoardsTooLargeError extends BoardsApiError {
  constructor(message: string) {
    super(413, "too_large", message);
    this.name = "BoardsTooLargeError";
  }
}

const SESSION_ERROR_MESSAGE =
  "euidos storage: your session expired or the server is unreachable — reload this page to sign in again";

/**
 * One static build serves both origins, so the API base is derived per call and
 * never baked in (same rule as `data/euidosStorage.ts`).
 */
export const apiUrl = (path: string) => `${window.location.origin}/api${path}`;

const messageOf = (payload: unknown, fallback: string): string => {
  if (payload && typeof payload === "object") {
    const body = payload as { message?: unknown; error?: unknown };
    if (typeof body.message === "string" && body.message) {
      return body.message;
    }
    if (typeof body.error === "string" && body.error) {
      return body.error;
    }
  }
  return fallback;
};

const codeOf = (payload: unknown, fallback: string): string => {
  if (payload && typeof payload === "object") {
    const body = payload as { error?: unknown };
    if (typeof body.error === "string" && body.error) {
      return body.error;
    }
  }
  return fallback;
};

const errorFor = (status: number, payload: unknown): Error => {
  const message = messageOf(payload, `Request failed (${status})`);
  switch (status) {
    // 401 is the only status that means "you are no longer signed in". A
    // Cloudflare Access session that expired answers the app's fetch this way
    // (or fails it outright, handled below) and nothing works again until the
    // page is reloaded through the login redirect.
    case 401:
      return new EuidosSessionError(SESSION_ERROR_MESSAGE);
    case 403:
      return new BoardsForbiddenError(message);
    case 404:
      return new BoardsNotFoundError(message);
    case 409:
      return new BoardsConflictError(message);
    case 413:
      return new BoardsTooLargeError(message);
    default:
      return new BoardsApiError(status, codeOf(payload, "error"), message);
  }
};

/**
 * Every boards-API call goes through here.
 *
 * A rejected `fetch()` on a same-origin `/api` path is either the Access login
 * redirect failing the fetch's CORS check or the origin being down; both are
 * fixed by reloading, and both are reported as the same `EuidosSessionError`
 * the collab save path raises — so one `isSessionError()` check covers the app.
 */
export const request = async <T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> => {
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    // Cache-busting is not optional for GET /api/boards: the list must be right
    // after a create/rename/delete, and a bfcache-served 200 would show the old
    // one. The backend already sends `cache-control: no-store`; this covers the
    // request side too.
    cache: "no-store",
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch {
    throw new EuidosSessionError(SESSION_ERROR_MESSAGE);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  let payload: unknown = null;
  try {
    const text = await response.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    // a non-JSON body (an edge error page, a proxy timeout) is not fatal by
    // itself — the status is what decides, and `errorFor` has a fallback text
    payload = null;
  }

  if (!response.ok) {
    throw errorFor(response.status, payload);
  }
  return payload as T;
};

/** `GET /api/me`. Use `identity.ts`, which caches this for the session. */
export const fetchIdentity = () => request<Identity>("GET", "/me");

/** `GET /api/boards` — newest scene edit first; the backend does the ordering. */
export const fetchBoards = async (): Promise<Board[]> => {
  const payload = await request<{ boards?: Board[] }>("GET", "/boards");
  return Array.isArray(payload?.boards) ? payload.boards : [];
};

/**
 * `POST /api/boards`. `id`/`roomKey` are minted by the app's own
 * `generateCollaborationLinkData()` so the row and the `#room=` link agree by
 * construction — the backend never invents either.
 */
export const createBoard = (board: {
  id: string;
  roomKey: string;
  name: string;
}) => request<Board>("POST", "/boards", board);

/** `PATCH /api/boards/:id` — 403 for the wall, and does NOT bump `updatedAt`. */
export const renameBoard = (id: string, name: string) =>
  request<Board>("PATCH", `/boards/${encodeURIComponent(id)}`, { name });

/** `DELETE /api/boards/:id` — soft delete, 204, 403 for the wall. */
export const deleteBoard = (id: string) =>
  request<void>("DELETE", `/boards/${encodeURIComponent(id)}`);

/** The backend's own cap (`requireName`); the input is limited to match. */
export const MAX_BOARD_NAME_LENGTH = 200;
