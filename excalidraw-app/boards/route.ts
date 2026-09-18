/**
 * Where the boards page lives in the URL space (a pure rule, testable without a
 * DOM) and the four navigations between the two screens.
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

import { flushEditorScene, navigation } from "./leave";

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

/**
 * A board this app can actually open.
 *
 * The check is the LINK PARSER's, not "the backend stored something": the
 * backend's `ROOM_KEY_RE` accepts `+`, `/`, `=` and any length 0-256, while
 * upstream's `RE_COLLAB_LINK` (`data/index.ts`) only matches
 * `[a-zA-Z0-9_-]+` and `getCollaborationLinkData()` additionally rejects a key
 * that is not 22 characters. A row outside that intersection (only reachable
 * by a direct API POST today — the page mints its keys with
 * `generateEncryptionKey`) would otherwise get an enabled "Copy link" whose URL
 * either silently drops the room or pops upstream's "invalid encryption key"
 * alert. RETRO G-P3.2 is "never hand out a broken link", so the UI answers the
 * question the editor will ask, not the one the database asked.
 */
export const ROOM_KEY_RE = /^[a-zA-Z0-9_-]{22}$/;
const ROOM_ID_RE = /^[a-zA-Z0-9_-]+$/;

export const hasLink = (board: { id: string; roomKey: string }): boolean =>
  ROOM_ID_RE.test(board.id) && ROOM_KEY_RE.test(board.roomKey);

export const boardsUrl = (): string =>
  `${window.location.origin}${BOARDS_PATH}`;

/**
 * Opening a board from the boards page is a hash change on the SAME document
 * when we are already at `/` (no reload, the route swaps in place) and a real
 * navigation when we are at `/boards`. Assigning the full URL covers both.
 *
 * Rows render the name as an `<a href>`, so this is only the programmatic path
 * (creating a board); a click is the browser's own navigation, which is what
 * makes ctrl-click and "open in new tab" work.
 */
export const openBoard = (board: { id: string; roomKey: string }) => {
  navigation.assign(boardLink(board));
};

/**
 * Leaving a board for the list, from the main menu.
 *
 * The scene is FLUSHED first (`leave.ts`): the unload path saves nothing, so
 * without this the last throttle window of drawing is lost and the browser pops
 * its own "Leave site?" prompt on the way out — the app's own navigation
 * offering the user a choice between two kinds of data loss.
 */
export const gotoBoards = async () => {
  await flushEditorScene();
  navigation.assign(boardsUrl());
};

/**
 * Back/Forward out of a live board.
 *
 * A same-document hash change cannot warn and does not unload, so the editor
 * would be unmounted in place with its scene unsaved and its socket still open.
 * Flush, then do a REAL navigation (a reload of the URL the history entry
 * already put in the address bar, i.e. the boards list), which tears the
 * session down the way a closed tab does.
 */
export const leaveEditorForBoards = async () => {
  await flushEditorScene();
  navigation.reload();
};
