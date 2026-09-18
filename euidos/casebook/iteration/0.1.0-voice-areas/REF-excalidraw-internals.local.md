# REF — @excalidraw/excalidraw 0.18.1 internals that the build relies on (verified in node_modules/dist/dev)

- Props: `excalidrawAPI`, `initialData`, `onChange(elements, appState, files)`, `onPointerDown/onPointerUp(activeTool,
  pointerDownState)`, `renderTopRightUI`, `langCode`, `UIOptions`. API: `updateScene({elements, appState, captureUpdate})`,
  `getSceneElements`, `getSceneElementsIncludingDeleted`, `getAppState`, `setActiveTool`, `onPointerDown(cb)`,
  `onPointerUp(cb)` (cb gets the raw PointerEvent as 3rd arg), `onChange(cb)`, `setToast`, `updateLibrary`.
- `props.onPointerUp` / `onPointerUpEmitter` fire BEFORE the freedraw element is finalised (index.js ~31900 → the
  `newElement.type === "freedraw"` branch comes after). Read the finished element one frame later.
- A `custom` tool makes the canvas inert on pointer down (only sets the cursor) — so stroke capture hijacks the
  `freedraw` tool instead. Freedraw stays the active tool after a stroke (only non-freedraw tools reset to selection).
- `convertToExcalidrawElements([{type:'ellipse', ..., label:{text, fontSize, fontFamily}}])` creates the bound text via
  `bindTextToContainer` → `redrawTextBoundingBox`, which GROWS the container when the text does not fit. Fitting =
  binary-search the largest fontSize for which container width/height stay unchanged.
- Bound text max width for ellipse is inscribed (width/√2 − padding); `BOUND_TEXT_PADDING` = 5. Text elements carry
  `containerId`, `autoResize`, `lineHeight`, `angle`; containers list `{type:'text', id}` in `boundElements`.
- Toolbar (desktop): `.App-toolbar .Stack_horizontal` holds `label.ToolIcon.Shape` buttons with
  `input.ToolIcon_type_radio[data-testid="toolbar-<tool>"]` + `div.ToolIcon__icon` (+ `span.ToolIcon__keybinding`),
  then `div.App-toolbar__divider`, then `.App-toolbar__extra-tools-trigger`. Checked style comes from
  `.ToolIcon_type_radio:checked+.ToolIcon__icon { background: var(--color-surface-primary-container) }`.
- Fonts resolve as `new URL("fonts/<Family>/<file>.woff2", window.EXCALIDRAW_ASSET_PATH)`; ship
  `dist/prod/fonts` at `/fonts` and set `window.EXCALIDRAW_ASSET_PATH = "/"` (the vanilla deploy used the same layout).
- Vite needs `define: { "process.env.IS_PREACT": JSON.stringify("false") }`.
- excalidraw-app (vanilla) localStorage keys: `excalidraw` (elements JSON), `excalidraw-state` (appState JSON),
  `excalidraw-library`, `excalidraw-theme`; binary files in IndexedDB `files-db` / store `files-store` (idb-keyval).
- `FONT_FAMILY` = { Virgil 1, Helvetica 2, Cascadia 3, Excalifont 5, Nunito 6, "Lilita One" 7, "Comic Shanns" 8,
  "Liberation Sans" 9 }; DEFAULT_FONT_SIZE 20.
