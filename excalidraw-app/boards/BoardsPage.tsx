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
 *  - "Copy link" is disabled for a board whose `roomKey` is `""` — rows from
 *    before phase 1 stored the key (G-P3.2). There is no backfill route, so the
 *    honest UI is "Link unavailable", not a URL that opens an empty room.
 *  - Creating a board mints `id`/`roomKey` with the app's own
 *    `generateCollaborationLinkData()` and POSTs them, so the row and the
 *    `#room=` link agree by construction.
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
import { boardLink, hasLink, openBoard } from "./route";

import "./boards.css";

import type { Board, Identity } from "./api";

const DEFAULT_BOARD_NAME = "Untitled board";

const NO_LINK_HINT =
  "This board has no room key stored, so it has no shareable link. It was created before the key was saved with the board.";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; boards: Board[] };

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

export const BoardsPage = () => {
  const { editorTheme } = useHandleAppTheme();

  const [list, setList] = useState<ListState>({ status: "loading" });
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Board | null>(null);

  const newNameRef = useRef<HTMLInputElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    setList({ status: "loading" });
    try {
      // one round trip each, in parallel: the identity decides which controls
      // exist at all, so the list is not rendered before it is known
      const [me, boards] = await Promise.all([getIdentity(), fetchBoards()]);
      setIdentity(me);
      setList({ status: "ready", boards });
    } catch (error) {
      setList({ status: "error", message: messageOf(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
  useEffect(() => {
    if (pendingDelete) {
      confirmRef.current?.focus();
    }
  }, [pendingDelete]);

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
    if (!name || name === board.name) {
      setRenamingId(null);
      return;
    }
    setBusy(true);
    try {
      replaceBoard(await renameBoard(board.id, name));
      setRenamingId(null);
      setNotice(null);
    } catch (error) {
      setNotice({ kind: "error", text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (board: Board) => {
    setBusy(true);
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
          <button
            type="button"
            className="euidos-boards__button--primary"
            data-testid="boards-new"
            disabled={busy || list.status === "loading"}
            onClick={() => {
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
              {notice.text}
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
            <button
              type="button"
              data-testid="boards-retry"
              style={{ marginTop: "0.5rem" }}
              onClick={() => void load()}
            >
              Try again
            </button>
          </div>
        )}

        {list.status === "ready" && list.boards.length === 0 && (
          <div className="euidos-boards__empty" data-testid="boards-empty">
            No boards yet. “New board” makes the first one.
          </div>
        )}

        {list.status === "ready" && list.boards.length > 0 && (
          <ul className="euidos-boards__list">
            {list.boards.map((board) => {
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
                        <button
                          type="button"
                          className="euidos-boards__name"
                          data-testid="board-open"
                          onClick={() => openBoard(board)}
                        >
                          {board.name}
                        </button>
                        <div
                          className="euidos-boards__meta"
                          data-testid="board-meta"
                          title={formatAbsoluteTime(board.updatedAt)}
                        >
                          {formatElementCount(board.elementCount)} · last edited{" "}
                          {formatLastEdited(board)}
                        </div>
                      </>
                    )}
                  </div>

                  {renamingId !== board.id && (
                    <div className="euidos-boards__actions">
                      <button
                        type="button"
                        data-testid="board-open-button"
                        onClick={() => openBoard(board)}
                      >
                        Open
                      </button>
                      <span title={linkable ? undefined : NO_LINK_HINT}>
                        <button
                          type="button"
                          data-testid="board-copy"
                          disabled={!linkable}
                          aria-describedby={
                            linkable ? undefined : `euidos-nolink-${board.id}`
                          }
                          onClick={() => void onCopyLink(board)}
                        >
                          {linkable ? "Copy link" : "Link unavailable"}
                        </button>
                      </span>
                      {!linkable && (
                        <span
                          className="euidos-boards__sr-only"
                          id={`euidos-nolink-${board.id}`}
                        >
                          {NO_LINK_HINT}
                        </span>
                      )}
                      {manages && (
                        <button
                          type="button"
                          data-testid="board-rename"
                          onClick={() => {
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
                          onClick={() => setPendingDelete(board)}
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
        <div
          className="euidos-boards__backdrop"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setPendingDelete(null);
            }
          }}
        >
          <div
            className="euidos-boards__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="euidos-delete-title"
            data-testid="board-delete-confirm"
          >
            <h2 id="euidos-delete-title">Delete “{pendingDelete.name}”?</h2>
            <p>
              It disappears for everyone and its link stops working. Recovering
              it needs a database edit on the host, so there is no undo here.
            </p>
            <div className="euidos-boards__dialog-actions">
              <button
                type="button"
                data-testid="board-delete-cancel"
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                ref={confirmRef}
                className="euidos-boards__button--danger"
                data-testid="board-delete-confirm-yes"
                disabled={busy}
                onClick={() => void onDelete(pendingDelete)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BoardsPage;
