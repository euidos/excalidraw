/**
 * Where the boards page lives in the URL space, as pure functions so the rule
 * is testable without a DOM.
 *
 * There is no router in this app and adding one for two screens would be a new
 * dependency threaded through upstream's `App.tsx`. The whole route contract is:
 *
 *   /boards             -> the boards page (nginx `try_files $uri /index.html`)
 *   /        (no hash)  -> the boards page, so a bare origin lands on your boards
 *   /#room=id,key       -> the editor, joined to that board
 *   /#json=…            -> the editor, opening a share link
 *   /#local             -> the editor on the local scratch scene
 *   /#addLibrary=…      -> the editor (upstream's library install links)
 *
 * The last two are why this is not simply "no `#room=` and no `#json=`": ANY
 * non-empty hash on the root means the editor was addressed on purpose, and
 * swallowing it would break `#addLibrary` installs and the scratch board.
 */

export const BOARDS_PATH = "/boards";

/** `location`-shaped, so tests can pass a literal. */
export type RouteLocation = { pathname: string; hash: string };

const isEditorHash = (hash: string) =>
  hash.startsWith("#room=") || hash.startsWith("#json=");

export const isBoardsLocation = (loc: RouteLocation): boolean => {
  if (isEditorHash(loc.hash)) {
    return false;
  }
  const path = loc.pathname.replace(/\/+$/, "");
  if (path === BOARDS_PATH) {
    return true;
  }
  if (path === "") {
    return loc.hash === "" || loc.hash === "#" || loc.hash === "#boards";
  }
  return false;
};

/**
 * Always the ROOT path, never `location.pathname` (which upstream's
 * `getCollaborationLink` uses): a link minted on `/boards` would otherwise read
 * `/boards#room=…`, which works only because nginx falls back to `index.html`
 * and reads like a bug in every chat message it is pasted into.
 */
export const boardLink = (board: { id: string; roomKey: string }): string =>
  `${window.location.origin}/#room=${board.id},${board.roomKey}`;

/** A board with no stored room key has no link at all (RETRO G-P3.2). */
export const hasLink = (board: { roomKey: string }): boolean =>
  board.roomKey.length > 0;

export const boardsUrl = (): string =>
  `${window.location.origin}${BOARDS_PATH}`;

/**
 * Opening a board from the boards page is a hash change on the SAME document
 * when we are already at `/` (no reload, the route swaps in place) and a real
 * navigation when we are at `/boards`. Assigning the full URL covers both.
 */
export const openBoard = (board: { id: string; roomKey: string }) => {
  window.location.assign(boardLink(board));
};

/**
 * Leaving a board for the list is always a full navigation, deliberately: it
 * tears the collab session and the voice controller down through the same
 * unload path a closed tab uses, instead of inventing a second teardown order
 * (RETRO G-P2.8 — a programmatic "leave" that saves faster than a tab close is
 * exactly the exposure that gate warns about).
 */
export const gotoBoards = () => {
  window.location.assign(boardsUrl());
};
