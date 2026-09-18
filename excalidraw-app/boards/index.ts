/**
 * The boards page's public surface for upstream's files, so `App.tsx` and
 * `AppMainMenu.tsx` import from `../boards` and never from a module inside it —
 * the smaller the footprint in those files, the smaller the rebase conflict
 * when they move upstream (same reasoning as `voice/index.ts`).
 *
 * `collab/Collab.tsx` deliberately reaches for `../boards/identity` instead:
 * it needs one function, and routing it through here would drag the whole
 * boards page (React tree, CSS, the editor's theme hook) into the collab
 * module's import graph for nothing.
 */
export { BoardsRoute } from "./BoardsRoute";
export { BoardsMenuItem } from "./BoardsMenuItem";
