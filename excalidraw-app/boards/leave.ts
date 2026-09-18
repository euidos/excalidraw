/**
 * Leaving a live board without losing the last strokes.
 *
 * The editor saves a collaborative scene on a throttle
 * (`SYNC_FULL_SCENE_INTERVAL_MS`, 20 s, `leading:false`), so at any moment up to
 * twenty seconds of drawing exists only in the tab. Neither of the two ways out
 * of a board saves it by itself:
 *
 *   * Back/Forward to the boards list is a SAME-DOCUMENT hash change. Nothing
 *     unloads, `beforeunload` cannot fire, and unmounting the editor in place
 *     just throws the scene away (and leaves the collab socket open).
 *   * The main menu's "Boards" is a real navigation, but the unload path only
 *     runs `Collab.onUnload` -> `destroySocketClient({isUnload:true})`, which
 *     closes the portal and writes nothing.
 *
 * So both paths flush first, through this registry: `Collab` registers one
 * function while it is mounted, and the boards navigation awaits it. The
 * registry (rather than a new `CollabAPI` method) keeps the cost inside
 * upstream's `Collab.tsx` to a single registration line, and keeps this
 * module's dependency direction boards -> nothing.
 */

/** Persist whatever is unsaved in the live editor. Resolves when it landed. */
type SceneFlush = () => Promise<unknown>;

let sceneFlush: SceneFlush | null = null;

/**
 * Called by `collab/Collab.tsx` on mount, and with `null` on unmount — a stale
 * closure over a torn-down editor would flush a scene nobody is looking at.
 */
export const registerSceneFlush = (flush: SceneFlush | null) => {
  sceneFlush = flush;
};

/** No editor mounted (the boards page itself) means nothing to flush. */
export const hasEditorScene = () => sceneFlush !== null;

/**
 * A save that cannot finish must not strand the user on a board they asked to
 * leave; after this long we navigate anyway, which is no worse than the
 * behaviour this whole module replaces.
 */
export const FLUSH_TIMEOUT_MS = 8_000;

export const flushEditorScene = async (
  timeoutMs: number = FLUSH_TIMEOUT_MS,
): Promise<void> => {
  const flush = sceneFlush;
  if (!flush) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // a failed save is reported by the editor's own error dialog; it must not
      // also block the navigation the user asked for
      Promise.resolve(flush()).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

/**
 * The one place this module touches `window.location`, so tests can drive the
 * navigation rules without jsdom's "Not implemented: navigation" noise.
 */
export const navigation = {
  assign: (url: string) => window.location.assign(url),
  reload: () => window.location.reload(),
};
