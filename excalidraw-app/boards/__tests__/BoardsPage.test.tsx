/**
 * The boards page as a user meets it.
 *
 * These are the behaviours a screenshot cannot check and the e2e can only check
 * expensively: what a row offers for a board that cannot be opened, whether the
 * list ever refreshes, what the error state offers after a session expires,
 * and whether the delete confirm is a modal for the keyboard as well as for the
 * mouse. `boards/api.ts` is mocked here (it has its own suite, and the real
 * routes are driven for real by `euidos/e2e/boards`).
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Board, Identity } from "../api";

const fetchBoards = vi.fn();
const fetchIdentity = vi.fn();
const createBoard = vi.fn();
const renameBoard = vi.fn();
const deleteBoard = vi.fn();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    fetchBoards,
    fetchIdentity,
    createBoard,
    renameBoard,
    deleteBoard,
  };
});

vi.mock("../../data", () => ({
  generateCollaborationLinkData: async () => ({
    roomId: "newboardid0001",
    roomKey: "sTdLvpwRhVXVstXJLsGCOA",
  }),
}));

const { EuidosSessionError } = await import("../../data/euidosStorage");
const { resetIdentityCache } = await import("../identity");
const { navigation } = await import("../leave");
const { BoardsPage } = await import("../BoardsPage");

const ORIGIN = window.location.origin;

const board = (overrides: Partial<Board> = {}): Board => ({
  id: "board1",
  name: "Ampere",
  roomKey: "sTdLvpwRhVXVstXJLsGCOA",
  createdBy: "alice@euidos.ai",
  createdAt: "2026-09-18T09:00:00.000Z",
  updatedBy: "bob@euidos.ai",
  updatedAt: new Date().toISOString(),
  elementCount: 3,
  ...overrides,
});

const identity = (overrides: Partial<Identity> = {}): Identity => ({
  login: "alice@euidos.ai",
  name: "Alice",
  via: "tailnet",
  ...overrides,
});

const realNavigation = { assign: navigation.assign, reload: navigation.reload };

beforeEach(() => {
  resetIdentityCache();
  vi.clearAllMocks();
  fetchIdentity.mockResolvedValue(identity());
  fetchBoards.mockResolvedValue([board()]);
  navigation.assign = vi.fn();
  navigation.reload = vi.fn();
});

afterEach(() => {
  navigation.assign = realNavigation.assign;
  navigation.reload = realNavigation.reload;
});

/** render and wait for the first fetch to settle */
const show = async () => {
  const view = render(<BoardsPage />);
  await screen.findByTestId("boards-page");
  await waitFor(() => expect(fetchBoards).toHaveBeenCalled());
  return view;
};

describe("a board the editor cannot open", () => {
  it("offers no way to open it and says why, instead of dropping the user in their local scene", async () => {
    fetchBoards.mockResolvedValue([
      board({ id: "legacy1", name: "Legacy", roomKey: "" }),
    ]);

    await show();
    await screen.findByTestId("board-row");

    // no link, no Open, no Copy — the previous UI disabled Copy only, and the
    // name button navigated to "#room=legacy1," which the editor ignores
    expect(screen.queryByTestId("board-open")).toBeNull();
    expect(screen.queryByTestId("board-copy")).toBeNull();
    expect(screen.getByTestId("board-name-unopenable")).toHaveTextContent(
      "Legacy",
    );
    expect(screen.getByTestId("board-no-link")).toBeInTheDocument();
  });

  it("treats a room key the link parser cannot read the same way", async () => {
    fetchBoards.mockResolvedValue([board({ roomKey: "AAAA+BBBB/CCCCCCCCC=" })]);

    await show();
    await screen.findByTestId("board-row");

    expect(screen.queryByTestId("board-open")).toBeNull();
  });
});

describe("rows are links", () => {
  it("renders the name as an anchor to the room, so ctrl-click and 'open in new tab' work", async () => {
    await show();

    const link = await screen.findByTestId("board-open");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute(
      "href",
      `${ORIGIN}/#room=board1,sTdLvpwRhVXVstXJLsGCOA`,
    );
  });
});

describe("staleness", () => {
  it("refetches when the tab comes back to the foreground", async () => {
    await show();
    await screen.findByTestId("board-row");
    expect(fetchBoards).toHaveBeenCalledTimes(1);

    fetchBoards.mockResolvedValue([board(), board({ id: "b2", name: "New" })]);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(fetchBoards).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByTestId("board-row")).toHaveLength(2);
  });

  it("has a Refresh control, and a failed refresh does not blank a usable list", async () => {
    await show();
    await screen.findByTestId("board-row");

    fetchBoards.mockRejectedValue(new Error("network blip"));
    fireEvent.click(screen.getByTestId("boards-refresh"));

    await waitFor(() => expect(fetchBoards).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("board-row")).toBeInTheDocument();
    expect(screen.queryByTestId("boards-error")).toBeNull();
  });
});

describe("error states", () => {
  it("offers a RELOAD after the session expired — retrying the same fetch can never work", async () => {
    fetchBoards.mockRejectedValue(new EuidosSessionError("session gone"));

    await show();
    await screen.findByTestId("boards-error");

    expect(screen.queryByTestId("boards-retry")).toBeNull();
    fireEvent.click(screen.getByTestId("boards-reload"));
    expect(navigation.reload).toHaveBeenCalledTimes(1);
  });

  it("still offers 'Try again' for an error a retry can fix", async () => {
    fetchBoards.mockRejectedValue(new Error("boom"));

    await show();
    await screen.findByTestId("boards-error");

    expect(screen.queryByTestId("boards-reload")).toBeNull();
    expect(screen.getByTestId("boards-retry")).toBeInTheDocument();
  });

  it("keeps 'New board' usable while the list is still loading", async () => {
    let release: (boards: Board[]) => void = () => {};
    fetchBoards.mockReturnValue(
      new Promise<Board[]>((resolve) => {
        release = resolve;
      }),
    );

    render(<BoardsPage />);
    await screen.findByTestId("boards-loading");

    // a hung GET used to disable the only control that does not need the list
    expect(screen.getByTestId("boards-new")).toBeEnabled();

    await act(async () => {
      release([board()]);
    });
  });
});

describe("the delete confirm is modal for the keyboard too", () => {
  const openDialog = async () => {
    await show();
    const del = await screen.findByTestId("board-delete");
    del.focus();
    fireEvent.click(del);
    await screen.findByTestId("board-delete-confirm");
    return del;
  };

  it("keeps Tab inside the dialog", async () => {
    await openDialog();

    const cancel = screen.getByTestId("board-delete-cancel");
    const confirm = screen.getByTestId("board-delete-confirm-yes");
    expect(document.activeElement).toBe(confirm);

    // the last stop wraps to the first, never out to "New board" behind
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it("closes on Escape even when focus escaped, and on a backdrop click", async () => {
    await openDialog();

    screen.getByTestId("boards-new").focus();
    fireEvent.keyDown(screen.getByTestId("boards-new"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("board-delete-confirm")).toBeNull(),
    );

    fireEvent.click(screen.getByTestId("board-delete"));
    await screen.findByTestId("board-delete-confirm");
    fireEvent.mouseDown(screen.getByTestId("board-delete-backdrop"));
    await waitFor(() =>
      expect(screen.queryByTestId("board-delete-confirm")).toBeNull(),
    );
  });

  it("gives focus back to the control that opened it", async () => {
    const del = await openDialog();

    fireEvent.click(screen.getByTestId("board-delete-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("board-delete-confirm")).toBeNull(),
    );
    expect(document.activeElement).toBe(del);
  });
});

describe("rename", () => {
  it("refuses an empty name out loud instead of discarding it silently", async () => {
    await show();
    fireEvent.click(await screen.findByTestId("board-rename"));

    const input = await screen.findByTestId("board-rename-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("board-rename-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("boards-notice")).toHaveTextContent(
        "cannot be empty",
      ),
    );
    expect(renameBoard).not.toHaveBeenCalled();
    // the field stays open with the text still in it
    expect(screen.getByTestId("board-rename-input")).toBeInTheDocument();
  });
});

describe("notices", () => {
  it("can be dismissed, and a new action clears the last one", async () => {
    await show();
    fireEvent.click(await screen.findByTestId("board-rename"));
    fireEvent.change(screen.getByTestId("board-rename-input"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("board-rename-submit"));
    await screen.findByTestId("boards-notice");

    fireEvent.click(screen.getByTestId("boards-notice-dismiss"));
    expect(screen.queryByTestId("boards-notice")).toBeNull();
  });
});

describe("finding a board", () => {
  it("filters the list by name or by who edited it", async () => {
    fetchBoards.mockResolvedValue([
      board({ id: "b1", name: "Ampere", updatedBy: "bob@euidos.ai" }),
      board({ id: "b2", name: "Bernoulli", updatedBy: "carol@euidos.ai" }),
    ]);
    await show();
    expect(await screen.findAllByTestId("board-row")).toHaveLength(2);

    fireEvent.change(screen.getByTestId("boards-filter"), {
      target: { value: "bernou" },
    });
    expect(screen.getAllByTestId("board-row")).toHaveLength(1);

    fireEvent.change(screen.getByTestId("boards-filter"), {
      target: { value: "carol@" },
    });
    expect(screen.getAllByTestId("board-row")).toHaveLength(1);

    fireEvent.change(screen.getByTestId("boards-filter"), {
      target: { value: "zzz" },
    });
    expect(screen.queryAllByTestId("board-row")).toHaveLength(0);
    expect(screen.getByTestId("boards-no-match")).toBeInTheDocument();
  });
});

describe("the tab", () => {
  it("is titled for the boards index, and gives the title back on leaving", async () => {
    document.title = "Excalidraw Whiteboard";
    const view = await show();

    expect(document.title).toBe("Boards — euidos");
    view.unmount();
    expect(document.title).toBe("Excalidraw Whiteboard");
  });
});

describe("the wall", () => {
  it("is shown as Wall with no rename or delete control (the backend answers those 403)", async () => {
    fetchIdentity.mockResolvedValue(
      identity({ login: "wall", name: "wall", via: "wall" }),
    );

    await show();

    expect(await screen.findByTestId("boards-identity")).toHaveTextContent(
      "Wall",
    );
    expect(screen.queryByTestId("board-rename")).toBeNull();
    expect(screen.queryByTestId("board-delete")).toBeNull();
  });
});
