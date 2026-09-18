/**
 * Reads and writes the VANILLA excalidraw-app storage keys so the founder's existing board, app state,
 * library and images carry over to this wrapper unchanged (DESIGN gate G6).
 */
import type { ExcalidrawElement } from "@excalidraw/element/types";
import { isFailedWarning, isInterimText, isRegionMarker } from "./contracts";
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

/**
 * Both the library and the IndexedDB store are acquired lazily: `createStore` opens the database at call time and
 * `@excalidraw/excalidraw` pulls the whole editor bundle, which would make this module unimportable outside a
 * browser — and `sweepGhostPlaceholders` below is a pure function that must be unit-testable in node.
 */
const lib = () => import("@excalidraw/excalidraw");

let filesStoreRef: ReturnType<typeof createStore> | null = null;
const filesStore = () => (filesStoreRef ??= createStore("files-db", "files-store"));

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
    for (const [id, value] of await entries<string, BinaryFileData>(filesStore())) {
      if (value && typeof value === "object" && "dataURL" in value) {
        files[String(id)] = value;
      }
    }
  } catch (err) {
    console.warn("[voice] could not read files-db", err);
  }
  return files;
}

/** Placeholder animation frames written by fit.setPlaceholderFrame; see contracts.ts FitModule. */
const PLACEHOLDER_FRAMES = new Set(["\u00b7", "\u00b7\u00b7", "\u00b7\u00b7\u00b7"]);
const FAILED_PREFIX = "\u26a0 STT";

const isGhostText = (text: string): boolean => {
  const t = text.trim();
  return PLACEHOLDER_FRAMES.has(t) || t.startsWith(FAILED_PREFIX);
};

const textContentOf = (el: ExcalidrawElement): string | null => {
  const text = el as unknown as { text?: unknown };
  return typeof text.text === "string" ? text.text : null;
};

const containerIdOf = (el: ExcalidrawElement): string | null => {
  const text = el as unknown as { containerId?: unknown };
  return typeof text.containerId === "string" ? text.containerId : null;
};

/**
 * A reload during a pending transcription leaves three kinds of litter behind, because the controller that owned
 * them is gone and nothing will ever commit or discard them:
 *
 *   - ghost TEXTS: a placeholder frame ("\u00b7"), or a "\u26a0 STT" warning the app stamped
 *     (`customData.voiceFailed`, round 4c — a warning is often UNBOUND, and a founder-typed "\u26a0 STT \u2026" must
 *     survive, so the stamp decides, not the text);
 *   - INTERIM texts (`customData.voiceInterim`, round 5): the words so far, drawn at 45 % opacity while the
 *     founder was still speaking. They read exactly like a real transcript, so only the stamp can tell them apart —
 *     and a reload mid-utterance must not leave half a sentence, faint, on the board for ever;
 *   - leftover region MARKERS (`customData.voiceRegion`, round 4a). A committed take deletes its own marker, so a
 *     marker that reached storage is by definition a take that never finished — pending, failed, or whose text the
 *     founder deleted by hand. Markers are scaffolding and are deleted outright; a marker is only kept if a real
 *     (non-ghost) text is bound to it, which the app never produces but a hand-edited scene could.
 *
 * A container that is NOT a marker is a shape the founder drew before round 4a, or by hand: that one is kept, and
 * only the ghost is unbound from it and its dashed "pending" stroke restored. Nothing else is touched.
 *
 * Pure so it can be unit-tested without the library's restore pipeline. Returns a NEW array; only the touched
 * elements are replaced (shallow copies), the rest are passed through.
 */
export function sweepGhostPlaceholders<T extends ExcalidrawElement>(elements: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const el of elements) {
    byId.set(el.id, el);
  }

  /** containerId -> ids of ghost texts to unbind from it (markers are deleted instead, never unbound) */
  const unbind = new Map<string, Set<string>>();
  const deleted = new Set<string>();
  /** Markers with a real text bound to them: the one case a marker survives the sweep. */
  const claimedMarkers = new Set<string>();

  for (const el of elements) {
    if (el.isDeleted || el.type !== "text") {
      continue;
    }
    const content = textContentOf(el);
    if (content === null) {
      continue;
    }
    const containerId = containerIdOf(el);
    // An interim preview carries real words, so `isGhostText` cannot see it: without the stamp check it would
    // CLAIM its marker (below) and the reload would keep both the dashed box and the half sentence.
    if (!isGhostText(content) && !isInterimText(el)) {
      if (containerId && content.trim()) {
        claimedMarkers.add(containerId);
      }
      continue;
    }
    if (!containerId) {
      // Free-standing litter: an orphan's placeholder, the text of a line region, or a "⚠ STT" warning that never
      // had (or has lost) its marker. A warning is only litter when the app STAMPED it (round 4c): deciding by text
      // content would also eat a founder-typed "⚠ STT …", and every warning this app writes carries the stamp.
      if (PLACEHOLDER_FRAMES.has(content.trim()) || isFailedWarning(el) || isInterimText(el)) {
        deleted.add(el.id);
      }
      continue;
    }
    deleted.add(el.id);
    const container = byId.get(containerId);
    if (!container || container.isDeleted || isRegionMarker(container)) {
      continue; // the container is gone, or it is a marker — which the marker pass below deletes wholesale
    }
    let set = unbind.get(containerId);
    if (!set) {
      set = new Set();
      unbind.set(containerId, set);
    }
    set.add(el.id);
  }

  for (const el of elements) {
    if (!el.isDeleted && isRegionMarker(el) && !claimedMarkers.has(el.id)) {
      deleted.add(el.id);
    }
  }

  if (!deleted.size && !unbind.size) {
    return elements.slice();
  }

  return elements.map((el) => {
    if (deleted.has(el.id)) {
      return { ...el, isDeleted: true };
    }
    const drop = unbind.get(el.id);
    if (!drop) {
      return el;
    }
    const bound = (el.boundElements ?? []).filter((b) => !drop.has(b.id));
    const next: Record<string, unknown> = { ...el, boundElements: bound.length ? bound : null };
    // The dashed stroke is the "transcription pending" cue; with the placeholder gone it must not linger.
    if (el.strokeStyle === "dashed") {
      next.strokeStyle = "solid";
    }
    return next as unknown as T;
  });
}

export async function loadInitialData(): Promise<ExcalidrawInitialDataState | null> {
  const { restoreAppState, restoreElements } = await lib();
  const rawElements = readJSON(KEY_ELEMENTS);
  const rawState = readJSON(KEY_STATE);
  const elements = sweepGhostPlaceholders(
    Array.isArray(rawElements) ? restoreElements(rawElements, null) : [],
  );
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
      idbSet(id, file, filesStore()).catch((err) => {
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
  async load(): Promise<{ libraryItems: LibraryItems } | null> {
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
      const { restoreLibraryItems } = await lib();
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
