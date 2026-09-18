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
 *
 * ONE of those two directions is not a route swap at all. Going boards ->
 * editor is free: there is nothing on the page to lose. Going editor -> boards
 * (Back out of a live board) would unmount an editor holding up to
 * `SYNC_FULL_SCENE_INTERVAL_MS` of unsaved drawing, with its collab socket
 * still open and no `beforeunload` possible on a same-document hash change. So
 * that direction flushes the scene and then does a REAL navigation
 * (`leaveEditorForBoards`), which tears the session down the way a closed tab
 * does.
 */
import { isTestEnv } from "@excalidraw/common";
import { useEffect, useRef, useState } from "react";

import { BoardsPage } from "./BoardsPage";
import { isBoardsLocation, leaveEditorForBoards } from "./route";

import type { ReactNode } from "react";

/**
 * jsdom's document lives at a bare `http://localhost/`, which IS the boards
 * route — and upstream's `excalidraw-app/tests/*` mount `<ExcalidrawApp/>` to
 * drive the EDITOR, against no `/api` at all. The unit suite therefore always
 * gets the editor unless a test asks for the routing explicitly (the `enabled`
 * prop, which `boards/__tests__/BoardsRoute.test.tsx` uses to cover the rule
 * this short-circuit would otherwise hide). `isTestEnv()` is
 * `import.meta.env.MODE === "test"`, so this is a compile-time constant in
 * every shipped build.
 */
export const routingEnabled = () => !isTestEnv();

export const BoardsRoute = ({
  children,
  enabled,
}: {
  children: ReactNode;
  /** test seam; production always gets `routingEnabled()` */
  enabled?: boolean;
}) => {
  const on = enabled ?? routingEnabled();
  const [onBoards, setOnBoards] = useState(
    () => on && isBoardsLocation(window.location),
  );
  // read by the listener, which must not be re-registered on every render
  const onBoardsRef = useRef(onBoards);
  onBoardsRef.current = onBoards;

  useEffect(() => {
    const sync = () => {
      const next = on && isBoardsLocation(window.location);
      if (next === onBoardsRef.current) {
        return;
      }
      if (next) {
        // editor -> boards: never swap in place, see the file's note
        onBoardsRef.current = true;
        void leaveEditorForBoards();
        return;
      }
      onBoardsRef.current = next;
      setOnBoards(next);
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, [on]);

  return onBoards ? <BoardsPage /> : <>{children}</>;
};

export default BoardsRoute;
