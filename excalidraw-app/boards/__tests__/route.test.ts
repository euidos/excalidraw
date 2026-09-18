import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flushEditorScene, navigation, registerSceneFlush } from "../leave";
import {
  boardLink,
  gotoBoards,
  hasLink,
  isBoardsLocation,
  leaveEditorForBoards,
  openBoard,
} from "../route";

const at = (pathname: string, hash = "") =>
  isBoardsLocation({ pathname, hash });

describe("isBoardsLocation", () => {
  it("shows the boards page at /boards and at a bare root", () => {
    expect(at("/boards")).toBe(true);
    expect(at("/boards/")).toBe(true);
    expect(at("/")).toBe(true);
    expect(at("/", "#")).toBe(true);
  });

  it("never swallows a link that addresses the editor", () => {
    expect(at("/", "#room=abc,key")).toBe(false);
    expect(at("/", "#json=123,key")).toBe(false);
    expect(at("/boards", "#room=abc,key")).toBe(false);
  });

  it("leaves the local scratch board and upstream's library links to the editor", () => {
    // any OTHER hash on the root means the editor was addressed on purpose —
    // #local is the scratch board, #addLibrary is an upstream install link
    expect(at("/", "#local")).toBe(false);
    expect(at("/", "#addLibrary=https://example.com/lib.excalidrawlib")).toBe(
      false,
    );
    expect(at("/", "#url=https://example.com/scene.excalidraw")).toBe(false);
  });

  it("is not a catch-all: other paths keep whatever they are", () => {
    expect(at("/excalidraw-plus-export")).toBe(false);
    expect(at("/boardsomething")).toBe(false);
  });
});

describe("boardLink", () => {
  it("is always rooted at the origin, never at the current path", () => {
    // minted from /boards, a pathname-relative link would read /boards#room=…
    expect(boardLink({ id: "abc123", roomKey: "sTdLvpwRhVXVstXJLsGCOA" })).toBe(
      `${window.location.origin}/#room=abc123,sTdLvpwRhVXVstXJLsGCOA`,
    );
  });
});

describe("hasLink", () => {
  const board = (roomKey: string, id = "board1") => ({ id, roomKey });

  it("is false for the pre-phase-1 rows whose room key was never stored", () => {
    expect(hasLink(board(""))).toBe(false);
    expect(hasLink(board("sTdLvpwRhVXVstXJLsGCOA"))).toBe(true);
  });

  it("answers the LINK PARSER, not the backend: a key the editor cannot read has no link", () => {
    // the backend's ROOM_KEY_RE allows + / = and any length 0-256; upstream's
    // RE_COLLAB_LINK is [a-zA-Z0-9_-]+ and the key must be 22 chars, so these
    // would have rendered an enabled "Copy link" to a URL that opens nothing
    expect(hasLink(board("AAAA+BBBB/CCCCCCCCCC="))).toBe(false);
    expect(hasLink(board("tooshort"))).toBe(false);
    expect(hasLink(board("sTdLvpwRhVXVstXJLsGCOAextra"))).toBe(false);
    expect(hasLink(board("sTdLvpwRhVXVstXJLsGCOA", "bad id"))).toBe(false);
  });
});

describe("leaving a live board", () => {
  let flush: ReturnType<typeof vi.fn>;
  const real = { assign: navigation.assign, reload: navigation.reload };

  beforeEach(() => {
    flush = vi.fn().mockResolvedValue(undefined);
    registerSceneFlush(flush);
    navigation.assign = vi.fn();
    navigation.reload = vi.fn();
  });

  afterEach(() => {
    registerSceneFlush(null);
    navigation.assign = real.assign;
    navigation.reload = real.reload;
  });

  it("gotoBoards saves the scene BEFORE it navigates (the unload path never saves)", async () => {
    const order: string[] = [];
    flush.mockImplementation(async () => {
      order.push("flush");
    });
    (navigation.assign as ReturnType<typeof vi.fn>).mockImplementation(() =>
      order.push("navigate"),
    );

    await gotoBoards();

    expect(order).toEqual(["flush", "navigate"]);
    expect(navigation.assign).toHaveBeenCalledWith(
      `${window.location.origin}/boards`,
    );
  });

  it("Back out of a board flushes and then does a REAL navigation, not an in-place swap", async () => {
    const order: string[] = [];
    flush.mockImplementation(async () => {
      order.push("flush");
    });
    (navigation.reload as ReturnType<typeof vi.fn>).mockImplementation(() =>
      order.push("reload"),
    );

    await leaveEditorForBoards();

    expect(order).toEqual(["flush", "reload"]);
  });

  it("opening a board does not wait for a flush — there is nothing on the boards page to lose", () => {
    openBoard({ id: "abc123", roomKey: "sTdLvpwRhVXVstXJLsGCOA" });
    expect(flush).not.toHaveBeenCalled();
    expect(navigation.assign).toHaveBeenCalledWith(
      `${window.location.origin}/#room=abc123,sTdLvpwRhVXVstXJLsGCOA`,
    );
  });

  it("a flush that never resolves does not strand the user on the board", async () => {
    vi.useFakeTimers();
    try {
      flush.mockImplementation(() => new Promise(() => {}));
      const leaving = flushEditorScene(50);
      await vi.advanceTimersByTimeAsync(60);
      await leaving;
    } finally {
      vi.useRealTimers();
    }
  });
});
