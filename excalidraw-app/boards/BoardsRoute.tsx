/**
 * The whole router: boards page, or the editor.
 *
 * Mounted from `App.tsx` as one element wrapping `<ExcalidrawWrapper/>`, so
 * upstream's file carries a single import and a single JSX pair — the rule for
 * this fork's touchpoints (`euidos/docs/voice-tool-CLAUDE.md`).
 *
 * It re-reads the location on `hashchange` and `popstate` only. That is not a
 * gap: the editor rewrites the URL with `history.replaceState`/`pushState`
 * (`App.tsx` after a `#json=` import, `Collab.stopCollaboration`), and neither
 * fires an event — so an editor that quietly drops `#room=` from the address
 * bar keeps its scene instead of being unmounted mid-session. The transitions
 * that DO matter are a user-driven hash change (the boards page opening a
 * board) and Back/Forward, which are exactly the two events listened to here.
 */
import { isTestEnv } from "@excalidraw/common";
import { useEffect, useState } from "react";

import { BoardsPage } from "./BoardsPage";
import { isBoardsLocation } from "./route";

import type { ReactNode } from "react";

/**
 * jsdom's document lives at a bare `http://localhost/`, which IS the boards
 * route — and upstream's `excalidraw-app/tests/*` mount `<ExcalidrawApp/>` to
 * drive the EDITOR, against no `/api` at all. The unit suite therefore always
 * gets the editor; the boards page's own coverage is `boards/__tests__` (pure
 * units) and `euidos/e2e/boards` (the real backend). `isTestEnv()` is
 * `import.meta.env.MODE === "test"`, so this is a compile-time constant in
 * every shipped build.
 */
const routingEnabled = () => !isTestEnv();

export const BoardsRoute = ({ children }: { children: ReactNode }) => {
  const [onBoards, setOnBoards] = useState(
    () => routingEnabled() && isBoardsLocation(window.location),
  );

  useEffect(() => {
    const sync = () =>
      setOnBoards(routingEnabled() && isBoardsLocation(window.location));
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  return onBoards ? <BoardsPage /> : <>{children}</>;
};

export default BoardsRoute;
