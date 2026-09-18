/**
 * "Boards" in the main menu — the way back from a board to the index.
 *
 * Owned here rather than spelled out in upstream's `AppMainMenu.tsx` (same
 * pattern as `VoiceSettingsMenuItem`): the icon and the navigation rule live in
 * this directory, so upstream's file costs one import and one element.
 *
 * It is a NAVIGATION, not an in-place route swap: leaving a live board has to
 * tear the collab session and the voice controller down through the same unload
 * path a closed tab uses (see `route.ts`, RETRO G-P2.8).
 */
import { createIcon } from "@excalidraw/excalidraw/components/icons";
import { MainMenu } from "@excalidraw/excalidraw/index";

import { gotoBoards } from "./route";

const boardsIcon = createIcon(
  <g
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 5h7v6H4z" />
    <path d="M13 5h7v4h-7z" />
    <path d="M13 11h7v8h-7z" />
    <path d="M4 13h7v6H4z" />
  </g>,
  { width: 24, height: 24, fill: "none" },
);

export const BoardsMenuItem = () => (
  <MainMenu.Item
    icon={boardsIcon}
    data-testid="menu-boards"
    onSelect={() => gotoBoards()}
  >
    Boards
  </MainMenu.Item>
);
