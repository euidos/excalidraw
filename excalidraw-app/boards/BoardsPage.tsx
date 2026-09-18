/**
 * The boards index — the app's home screen.
 *
 * Plain React inside excalidraw-app, no router and no UI library: the editor's
 * own components assume they are inside `<Excalidraw>`'s context, and this page
 * renders without an editor at all. What it DOES borrow is the theme — the tree
 * is wrapped in `.excalidraw` (+ `.theme--dark`) so upstream's CSS variables
 * resolve and light/dark are the editor's, not a second palette.
 *
 * Decisions that are the founder's, not this file's (collab-plan phase 3):
 * every board is visible to every staff member, there are no per-board
 * permissions, no external sharing and no "show on wall".
 *
 * Decisions that ARE this file's, and why:
 *
 *  - Rename and delete are NOT RENDERED for `via:"wall"`. The backend answers
 *    them 403 (RETRO G-P3.1) and a control that always fails is worse than no
 *    control. The wall can still open boards and copy links.
 *  - A board the editor cannot open (`roomKey` `""`, or a key outside the link
 *    parser's alphabet — G-P3.2, `route.hasLink`) gets NO open affordance at
 *    all: not the name link, not a copy button. Opening one used to land the
 *    user in their private local scratch scene dressed up as that board.
 *  - The name is an `<a href>`, so ctrl-click, middle-click and "copy link
 *    address" work like they do everywhere else; "Copy link" stays for the
 *    common case of pasting a board into a chat.
 *  - Creating a board mints `id`/`roomKey` with the app's own
 *    `generateCollaborationLinkData()` and POSTs them, so the row and the
 *    `#room=` link agree by construction.
 *  - The list is a SHARED index that other people are editing, so it refetches
 *    whenever this tab comes back to the foreground, and says so with a
 *    Refresh control rather than pretending a first paint stays true.
 *  - Nothing here writes a scene. The boards page never touches
 *    `/api/rooms`, which is what keeps `scenes.element_count` honest (G-P3.3)
 *    and keeps voice scaffolding out of reach of anything but the sweep
 *    (G-P2.6).
 */
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";

import { THEME } from "@excalidraw/excalidraw";

import { useHandleAppTheme } from "../useHandleAppTheme";
import { generateCollaborationLinkData } from "../data";
import { isSessionError } from "../data/euidosStorage";

import {
  MAX_BOARD_NAME_LENGTH,
  createBoard,
  deleteBoard,
  fetchBoards,
  renameBoard,
} from "./api";
import {
  formatAbsoluteTime,
  formatElementCount,
  formatLastEdited,
} from "./format";
import { canManageBoards, displayNameFor, getIdentity } from "./identity";
import { navigation } from "./leave";
import { boardLink, hasLink, openBoard } from "./route";

import "./boards.css";

import type { Board, Identity } from "./api";

const DEFAULT_BOARD_NAME = "Untitled board";

const PAGE_TITLE = "Boards — euidos";

const NO_LINK_HINT =
  "This board has no usable room key stored, so it cannot be opened or shared from here. It was created before the key was saved with the board.";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string; session: boolean }
  | { status: "ready"; boards: Board[]; loadedAt: number };

type Notice = { kind: "info" | "error"; text: string };

const messageOf = (error: unknown): string => {
  if (isSessionError(error)) {
    return (error as Error).message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong. Try again.";
};

const matchesFilter = (board: Board, query: string) => {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return (
    board.name.toLowerCase().includes(needle) ||
    board.updatedBy.toLowerCase().includes(needle)
  );
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The delete confirm, as a real modal for the KEYBOARD too: `aria-modal` alone
 * inerts nothing, so without a trap two Tabs land on the page behind, Escape
 * (a handler on the dialog) stops working from there, and the background
 * controls stay operable while a destructive question is on screen.
 */
const ConfirmDeleteDialog = ({
  board,
  busy,
  onCancel,
  onConfirm,
}: {
  board: Board;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const stops = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((node) => node.getAttribute("aria-hidden") !== "true");
      if (stops.length === 0) {
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && dialog.contains(active);
      if (event.shiftKey ? !inside || active === first : !inside) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // capture, so the trap sees the key before anything the page listens for
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // a keyboard user must not be dropped back at <body>: return focus to the
      // control that opened this, or (it was just deleted) to "New board"
      const back =
        opener && opener.isConnected
          ? opener
          : document.querySelector<HTMLElement>('[data-testid="boards-new"]');
      back?.focus?.();
    };
  }, []);

  return (
    <div
      className="euidos-boards__backdrop"
      data-testid="board-delete-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="euidos-boards__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="euidos-delete-title"
        data-testid="board-delete-confirm"
      >
        <h2 id="euidos-delete-title">Delete “{board.name}”?</h2>
        <p>
          It disappears for everyone and its link stops working. Anyone who has
          it open will stop being able to save. Recovering it needs a database
          edit on the host, so there is no undo here.
        </p>
        <div className="euidos-boards__dialog-actions">
          <button
            type="button"
            data-testid="board-delete-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            ref={confirmRef}
            className="euidos-boards__button--danger"
            data-testid="board-delete-confirm-yes"
            disabled={busy}
            onClick={onConfirm}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};

export const BoardsPage = () => {
  const { editorTheme } = useHandleAppTheme();

  const [list, setList] = useState<ListState>({ status: "loading" });
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Board | null>(null);

  const newNameRef = useRef<HTMLInputElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);

  /**
   * `silent` is a refresh of a list that is already on screen (focus, the
   * Refresh button): it must not blank the page to "Loading boards…" and must
   * not replace a usable list with an error if the network blipped.
   */
  const load = useCallback(async (silent = false) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setList({ status: "loading" });
    }
    try {
      // one round trip each, in parallel: the identity decides which controls
      // exist at all, so the list is not rendered before it is known
      const [me, boards] = await Promise.all([getIdentity(), fetchBoards()]);
      setIdentity(me);
      setList({ status: "ready", boards, loadedAt: Date.now() });
    } catch (error) {
      if (!silent) {
        setList({
          status: "error",
          message: messageOf(error),
          session: isSessionError(error),
        });
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Other people create, rename and delete boards while this page is open, so
   * a list fetched once is stale the moment anyone else works. Refetching when
   * the tab comes back to the foreground costs one cheap GET and is when the
   * user is about to trust what they see.
   */
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void load(true);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  // the tab is a boards list, not "Excalidraw Whiteboard" — it is what the user
  // reads when a dozen tabs are open
  useEffect(() => {
    const previous = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = previous;
    };
  }, []);

  // focus follows the affordance that opened, so the keyboard never has to hunt
  useEffect(() => {
    if (creating) {
      newNameRef.current?.focus();
    }
  }, [creating]);
  useEffect(() => {
    if (renamingId) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renamingId]);

  const replaceBoard = (board: Board) =>
    setList((prev) =>
      prev.status === "ready"
        ? {
            ...prev,
            boards: prev.boards.map((it) => (it.id === board.id ? board : it)),
          }
        : prev,
    );

  const dropBoard = (id: string) =>
    setList((prev) =>
      prev.status === "ready"
        ? { ...prev, boards: prev.boards.filter((it) => it.id !== id) }
        : prev,
    );

  const onCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim() || DEFAULT_BOARD_NAME;
    setBusy(true);
    setNotice(null);
    try {
      const { roomId, roomKey } = await generateCollaborationLinkData();
      const board = await createBoard({ id: roomId, roomKey, name });
      // deliberately no setBusy(false): the page is navigating away
      openBoard(board);
    } catch (error) {
      setBusy(false);
      setNotice({ kind: "error", text: messageOf(error) });
    }
  };

  const onRename = async (board: Board, event: React.FormEvent) => {
    event.preventDefault();
    const name = renameValue.trim();
    if (!name) {
      // an emptied field used to close the editor and change nothing, silently
      setNotice({ kind: "error", text: "A board name cannot be empty." });
      renameRef.current?.focus();
      return;
    }
    if (name === board.name) {
      setRenamingId(null);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      replaceBoard(await renameBoard(board.id, name));
      setRenamingId(null);
    } catch (error) {
      setNotice({ kind: "error", text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (board: Board) => {
    setBusy(true);
    setNotice(null);
    try {
      await deleteBoard(board.id);
      dropBoard(board.id);
      setPendingDelete(null);
      setNotice({ kind: "info", text: `Deleted “${board.name}”.` });
    } catch (error) {
      setNotice({ kind: "error", text: messageOf(error) });
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  };

  const onCopyLink = async (board: Board) => {
    const link = boardLink(board);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("no clipboard");
      }
      await navigator.clipboard.writeText(link);
      setNotice({ kind: "info", text: `Link copied: ${link}` });
    } catch {
      // A browser may refuse the clipboard (no permission, insecure origin).
      // Showing the link is still useful — it can be selected by hand.
      setNotice({
        kind: "error",
        text: `Could not use the clipboard. The link is ${link}`,
      });
    }
  };

  const manages = canManageBoards(identity);
  const boards = list.status === "ready" ? list.boards : [];
  const visible = boards.filter((board) => matchesFilter(board, filter));

  return (
    <div
      className={clsx("excalidraw", "euidos-boards-root", {
        "theme--dark": editorTheme === THEME.DARK,
      })}
    >
      <main className="euidos-boards" data-testid="boards-page">
        <div className="euidos-boards__header">
          <h1 className="euidos-boards__title">Boards</h1>
          {identity && (
            <span
              className="euidos-boards__identity"
              data-testid="boards-identity"
            >
              {displayNameFor(identity)}
            </span>
          )}
          <span className="euidos-boards__spacer" />
          {list.status === "ready" && (
            <button
              type="button"
              data-testid="boards-refresh"
              title={`Last updated ${formatAbsoluteTime(
                new Date(list.loadedAt).toISOString(),
              )}`}
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          )}
          <button
            type="button"
            className="euidos-boards__button--primary"
            data-testid="boards-new"
            // NOT disabled while the list loads: creating a board does not need
            // the list, and a hung GET used to lock the only useful control
            disabled={busy}
            onClick={() => {
              setNotice(null);
              setNewName("");
              setCreating(true);
            }}
          >
            New board
          </button>
        </div>

        {creating && (
          <form
            className="euidos-boards__create"
            onSubmit={onCreate}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setCreating(false);
              }
            }}
          >
            <div className="euidos-boards__form">
              <label
                className="euidos-boards__sr-only"
                htmlFor="euidos-new-board-name"
              >
                Board name
              </label>
              <input
                id="euidos-new-board-name"
                ref={newNameRef}
                className="euidos-boards__input"
                data-testid="boards-new-name"
                maxLength={MAX_BOARD_NAME_LENGTH}
                placeholder={DEFAULT_BOARD_NAME}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
              <button
                type="submit"
                className="euidos-boards__button--primary"
                data-testid="boards-new-submit"
                disabled={busy}
              >
                Create
              </button>
              <button
                type="button"
                data-testid="boards-new-cancel"
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        <div aria-live="polite">
          {notice && (
            <div
              className={clsx("euidos-boards__notice", {
                "euidos-boards__notice--error": notice.kind === "error",
              })}
              data-testid="boards-notice"
            >
              <span className="euidos-boards__notice-text">{notice.text}</span>
              <button
                type="button"
                className="euidos-boards__notice-dismiss"
                data-testid="boards-notice-dismiss"
                aria-label="Dismiss message"
                onClick={() => setNotice(null)}
              >
                ✕
              </button>
            </div>
          )}
        </div>

        {list.status === "loading" && (
          <div className="euidos-boards__empty" data-testid="boards-loading">
            Loading boards…
          </div>
        )}

        {list.status === "error" && (
          <div
            className="euidos-boards__notice euidos-boards__notice--error"
            data-testid="boards-error"
            role="alert"
          >
            <div>{list.message}</div>
            {list.session ? (
              // An expired Access session answers a fetch with a cross-origin
              // login redirect, which only a DOCUMENT navigation can follow —
              // so retrying the same fetch can never succeed, however often.
              <button
                type="button"
                className="euidos-boards__button--primary"
                data-testid="boards-reload"
                style={{ marginTop: "0.5rem" }}
                onClick={() => navigation.reload()}
              >
                Reload to sign in
              </button>
            ) : (
              <button
                type="button"
                data-testid="boards-retry"
                style={{ marginTop: "0.5rem" }}
                onClick={() => void load()}
              >
                Try again
              </button>
            )}
          </div>
        )}

        {list.status === "ready" && boards.length > 1 && (
          <div className="euidos-boards__filter">
            <label
              className="euidos-boards__sr-only"
              htmlFor="euidos-boards-filter"
            >
              Filter boards
            </label>
            <input
              id="euidos-boards-filter"
              type="search"
              className="euidos-boards__input"
              data-testid="boards-filter"
              placeholder="Filter by name or who edited it"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        )}

        {list.status === "ready" && boards.length === 0 && (
          <div className="euidos-boards__empty" data-testid="boards-empty">
            No boards yet. “New board” makes the first one.
          </div>
        )}

        {list.status === "ready" && boards.length > 0 && visible.length === 0 && (
          <div className="euidos-boards__empty" data-testid="boards-no-match">
            No board matches “{filter.trim()}”.
          </div>
        )}

        {visible.length > 0 && (
          <ul className="euidos-boards__list">
            {visible.map((board) => {
              const linkable = hasLink(board);
              return (
                <li
                  className="euidos-boards__row"
                  key={board.id}
                  data-testid="board-row"
                  data-board-id={board.id}
                >
                  <div className="euidos-boards__main">
                    {renamingId === board.id ? (
                      <form
                        className="euidos-boards__form"
                        onSubmit={(event) => void onRename(board, event)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setRenamingId(null);
                          }
                        }}
                      >
                        <label
                          className="euidos-boards__sr-only"
                          htmlFor={`euidos-rename-${board.id}`}
                        >
                          New name for {board.name}
                        </label>
                        <input
                          id={`euidos-rename-${board.id}`}
                          ref={renameRef}
                          className="euidos-boards__input"
                          data-testid="board-rename-input"
                          maxLength={MAX_BOARD_NAME_LENGTH}
                          value={renameValue}
                          onChange={(event) =>
                            setRenameValue(event.target.value)
                          }
                        />
                        <button
                          type="submit"
                          data-testid="board-rename-submit"
                          disabled={busy}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          data-testid="board-rename-cancel"
                          onClick={() => setRenamingId(null)}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        {linkable ? (
                          // a real link: ctrl-click, middle-click and the
                          // browser's own "copy link address" all work, and a
                          // plain click at `/` is the same in-place hash swap
                          // `openBoard` does
                          <a
                            className="euidos-boards__name"
                            data-testid="board-open"
                            href={boardLink(board)}
                          >
                            {board.name}
                          </a>
                        ) : (
                          <span
                            className="euidos-boards__name euidos-boards__name--dead"
                            data-testid="board-name-unopenable"
                            title={NO_LINK_HINT}
                          >
                            {board.name}
                          </span>
                        )}
                        <div
                          className="euidos-boards__meta"
                          data-testid="board-meta"
                          title={formatAbsoluteTime(board.updatedAt)}
                        >
                          {formatElementCount(board.elementCount)} · last edited{" "}
                          {formatLastEdited(board)}
                          {!linkable && (
                            <>
                              {" · "}
                              <span data-testid="board-no-link">
                                cannot be opened — no room key stored
                              </span>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {renamingId !== board.id && (
                    <div className="euidos-boards__actions">
                      {linkable && (
                        <button
                          type="button"
                          data-testid="board-copy"
                          onClick={() => void onCopyLink(board)}
                        >
                          Copy link
                        </button>
                      )}
                      {manages && (
                        <button
                          type="button"
                          data-testid="board-rename"
                          onClick={() => {
                            setNotice(null);
                            setRenameValue(board.name);
                            setRenamingId(board.id);
                          }}
                        >
                          Rename
                        </button>
                      )}
                      {manages && (
                        <button
                          type="button"
                          className="euidos-boards__button--danger"
                          data-testid="board-delete"
                          onClick={() => {
                            setNotice(null);
                            setPendingDelete(board);
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {pendingDelete && (
        <ConfirmDeleteDialog
          board={pendingDelete}
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void onDelete(pendingDelete)}
        />
      )}
    </div>
  );
};

export default BoardsPage;
