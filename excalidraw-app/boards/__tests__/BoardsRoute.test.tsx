/**
 * The router itself, with the test short-circuit bypassed (`enabled`).
 *
 * Without this file the rule was covered only by `isBoardsLocation` (a pure
 * function that never meets React) and by the e2e: `BoardsRoute` is a no-op in
 * the whole vitest suite, so `excalidraw-app/tests/collab.test.tsx` passing
 * proves nothing about the routing. The regressions worth catching here are
 * "the boards page swallowed the editor" and "Back out of a live board threw
 * the scene away".
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const leaveEditorForBoards = vi.fn().mockResolvedValue(undefined);

vi.mock("../route", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../route")>();
  return { ...actual, leaveEditorForBoards };
});

vi.mock("../BoardsPage", () => ({
  BoardsPage: () => <div data-testid="boards-page-stub">boards</div>,
}));

const { BoardsRoute } = await import("../BoardsRoute");

const goTo = (hash: string, pathname = "/") => {
  window.history.pushState({}, "", `${pathname}${hash}`);
};

const hashChange = () =>
  act(() => {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

const popState = () =>
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

const editor = <div data-testid="editor-stub">editor</div>;

beforeEach(() => {
  leaveEditorForBoards.mockClear();
  goTo("");
});

afterEach(() => {
  goTo("");
});

describe("BoardsRoute", () => {
  it.each([
    ["/", ""],
    ["/boards", ""],
  ])("renders the boards page at %s%s", (pathname, hash) => {
    goTo(hash, pathname);
    render(<BoardsRoute enabled={true}>{editor}</BoardsRoute>);
    expect(screen.getByTestId("boards-page-stub")).toBeInTheDocument();
  });

  it.each(["#room=abc123,sTdLvpwRhVXVstXJLsGCOA", "#local", "#addLibrary=x"])(
    "leaves %s to the editor",
    (hash) => {
      goTo(hash);
      render(<BoardsRoute enabled={true}>{editor}</BoardsRoute>);
      expect(screen.getByTestId("editor-stub")).toBeInTheDocument();
    },
  );

  it("is a no-op when routing is disabled (upstream's own tests mount at the bare root)", () => {
    render(<BoardsRoute enabled={false}>{editor}</BoardsRoute>);
    expect(screen.getByTestId("editor-stub")).toBeInTheDocument();
  });

  it("swaps the editor in when a board is opened from the list", async () => {
    render(<BoardsRoute enabled={true}>{editor}</BoardsRoute>);
    expect(screen.getByTestId("boards-page-stub")).toBeInTheDocument();

    goTo("#room=abc123,sTdLvpwRhVXVstXJLsGCOA");
    hashChange();

    await waitFor(() =>
      expect(screen.getByTestId("editor-stub")).toBeInTheDocument(),
    );
  });

  it("does NOT unmount a live editor on Back — it flushes the scene and navigates", async () => {
    goTo("#room=abc123,sTdLvpwRhVXVstXJLsGCOA");
    render(<BoardsRoute enabled={true}>{editor}</BoardsRoute>);
    expect(screen.getByTestId("editor-stub")).toBeInTheDocument();

    goTo("");
    hashChange();

    await waitFor(() => expect(leaveEditorForBoards).toHaveBeenCalledTimes(1));
    // the editor is still mounted while the flush runs: unmounting here is
    // exactly the bug (up to 20 s of drawing lives only in that component)
    expect(screen.getByTestId("editor-stub")).toBeInTheDocument();
    expect(screen.queryByTestId("boards-page-stub")).toBeNull();
  });

  it("does the same on Back/Forward (popstate), not only on hashchange", async () => {
    goTo("#room=abc123,sTdLvpwRhVXVstXJLsGCOA");
    render(<BoardsRoute enabled={true}>{editor}</BoardsRoute>);

    goTo("", "/boards");
    popState();

    await waitFor(() => expect(leaveEditorForBoards).toHaveBeenCalledTimes(1));
  });
});
