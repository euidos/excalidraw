/**
 * Reads and writes the VANILLA excalidraw-app storage keys so the founder's existing board, app state,
 * library and images carry over to this wrapper unchanged (DESIGN gate G6).
 */
import { restoreAppState, restoreElements, restoreLibraryItems } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawInitialDataState,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import { createStore, entries, set as idbSet } from "idb-keyval";

const KEY_ELEMENTS = "excalidraw";
const KEY_STATE = "excalidraw-state";
const KEY_LIBRARY = "excalidraw-library";
const KEY_THEME = "excalidraw-theme";

const filesStore = createStore("files-db", "files-store");

function readJSON(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn(`[voice] ignoring unreadable localStorage "${key}"`, err);
    return null;
  }
}

async function loadFiles(): Promise<BinaryFiles> {
  const files: BinaryFiles = {};
  try {
    for (const [id, value] of await entries<string, BinaryFileData>(filesStore)) {
      if (value && typeof value === "object" && "dataURL" in value) {
        files[String(id)] = value;
      }
    }
  } catch (err) {
    console.warn("[voice] could not read files-db", err);
  }
  return files;
}

export async function loadInitialData(): Promise<ExcalidrawInitialDataState | null> {
  const rawElements = readJSON(KEY_ELEMENTS);
  const rawState = readJSON(KEY_STATE);
  const elements = Array.isArray(rawElements) ? restoreElements(rawElements, null) : [];
  const theme = localStorage.getItem(KEY_THEME);

  let appState: Partial<AppState> | null = null;
  try {
    // restoreAppState drops the transient keys (collaborators, selection, …) the library refuses on init.
    appState = restoreAppState(rawState as AppState | null, null);
  } catch (err) {
    console.warn("[voice] app state unusable, starting from defaults", err);
  }
  if (appState && (theme === "light" || theme === "dark")) {
    appState.theme = theme;
  }

  const files = await loadFiles();
  if (!elements.length && !appState && !Object.keys(files).length) {
    return null;
  }
  return { elements, appState: appState ?? undefined, files, scrollToContent: false };
}

/**
 * Keys worth surviving a reload. `activeTool` is deliberately absent: reloading into the voice/freedraw
 * hijack would arm a tool the user never picked. The library's own clearAppStateForLocalStorage is not
 * exported at runtime (only its types are), hence this allowlist.
 */
const PERSISTED_STATE_KEYS = [
  "theme",
  "viewBackgroundColor",
  "zoom",
  "scrollX",
  "scrollY",
  "gridSize",
  "gridModeEnabled",
  "penMode",
  "penDetected",
  "zenModeEnabled",
  "objectsSnapModeEnabled",
  "name",
  "exportBackground",
  "exportEmbedScene",
  "exportWithDarkMode",
  "exportScale",
] as const;

function cleanAppState(appState: AppState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = appState as unknown as Record<string, unknown>;
  for (const key of PERSISTED_STATE_KEYS) {
    if (src[key] !== undefined) {
      out[key] = src[key];
    }
  }
  for (const key of Object.keys(src)) {
    if (key.startsWith("currentItem")) {
      out[key] = src[key];
    }
  }
  return out;
}

export interface Persister {
  onChange(elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles): void;
  flush(): void;
}

export function createPersister(): Persister {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: { elements: readonly ExcalidrawElement[]; appState: AppState; files: BinaryFiles } | null = null;
  const writtenFileIds = new Set<string>();

  const writeFiles = (files: BinaryFiles) => {
    for (const [id, file] of Object.entries(files)) {
      if (writtenFileIds.has(id) || !file) {
        continue;
      }
      writtenFileIds.add(id);
      idbSet(id, file, filesStore).catch((err) => {
        writtenFileIds.delete(id); // let a later change retry the failed write
        console.warn("[voice] could not persist file", id, err);
      });
    }
  };

  const write = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!latest) {
      return;
    }
    const { elements, appState, files } = latest;
    latest = null;
    try {
      localStorage.setItem(
        KEY_ELEMENTS,
        JSON.stringify(elements.filter((el) => !el.isDeleted)),
      );
      localStorage.setItem(KEY_STATE, JSON.stringify(cleanAppState(appState)));
      if (appState.theme) {
        localStorage.setItem(KEY_THEME, appState.theme);
      }
    } catch (err) {
      console.warn("[voice] could not persist scene", err);
    }
    writeFiles(files);
  };

  const onUnload = () => write();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      write();
    }
  };
  window.addEventListener("beforeunload", onUnload);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    onChange(elements, appState, files) {
      latest = { elements, appState, files };
      if (timer === null) {
        timer = setTimeout(write, 300);
      }
    },
    flush: write,
  };
}

/** Adapter shape expected by useHandleLibrary (LibraryPersistenceAdapter). */
export const libraryAdapter = {
  load(): { libraryItems: LibraryItems } | null {
    const raw = readJSON(KEY_LIBRARY);
    if (!raw) {
      return null;
    }
    // vanilla wrote either a bare item array or {library|libraryItems: [...]}
    const items = Array.isArray(raw)
      ? raw
      : ((raw as Record<string, unknown>).libraryItems ?? (raw as Record<string, unknown>).library);
    if (!Array.isArray(items)) {
      return null;
    }
    try {
      return { libraryItems: restoreLibraryItems(items, "unpublished") as LibraryItems };
    } catch (err) {
      console.warn("[voice] could not restore library", err);
      return null;
    }
  },
  save(libraryData: { libraryItems: LibraryItems }): void {
    try {
      localStorage.setItem(KEY_LIBRARY, JSON.stringify(libraryData.libraryItems));
    } catch (err) {
      console.warn("[voice] could not persist library", err);
    }
  },
};
