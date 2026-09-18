/**
 * The boards page's public surface for upstream's files, so `App.tsx` and
 * `AppMainMenu.tsx` import from `../boards` and never from a module inside it —
 * the smaller the footprint in those files, the smaller the rebase conflict
 * when they move upstream (same reasoning as `voice/index.ts`).
 *
 * Two upstream files deliberately reach for a LEAF inside this directory
 * instead: `collab/Collab.tsx` (`./identity`, `./leave`) and
 * `share/ShareDialog.tsx` (`./CollaboratorNameField`). Each needs one thing,
 * and routing it through here would drag the whole boards page (React tree,
 * CSS, the editor's theme hook) into the editor's import graph for nothing.
 */
export { BoardsRoute } from "./BoardsRoute";
export { BoardsMenuItem } from "./BoardsMenuItem";
