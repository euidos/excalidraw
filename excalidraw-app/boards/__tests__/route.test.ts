import { describe, expect, it } from "vitest";

import { boardLink, hasLink, isBoardsLocation } from "../route";

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
  it("is false for the pre-phase-1 rows whose room key was never stored", () => {
    expect(hasLink({ roomKey: "" })).toBe(false);
    expect(hasLink({ roomKey: "sTdLvpwRhVXVstXJLsGCOA" })).toBe(true);
  });
});
