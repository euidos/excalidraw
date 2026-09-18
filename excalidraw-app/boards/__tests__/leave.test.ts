/**
 * The scene-flush registry `collab/Collab.tsx` registers into and the boards
 * navigation awaits. What it has to guarantee is small and load-bearing: a
 * flush is awaited, a broken one cannot block the navigation, and a torn-down
 * editor cannot be flushed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FLUSH_TIMEOUT_MS,
  flushEditorScene,
  hasEditorScene,
  registerSceneFlush,
} from "../leave";

afterEach(() => {
  registerSceneFlush(null);
  vi.useRealTimers();
});

describe("flushEditorScene", () => {
  it("is a no-op with no editor mounted (the boards page itself)", async () => {
    expect(hasEditorScene()).toBe(false);
    await expect(flushEditorScene()).resolves.toBeUndefined();
  });

  it("awaits the registered flush before it resolves", async () => {
    let landed = false;
    registerSceneFlush(async () => {
      await Promise.resolve();
      landed = true;
    });

    await flushEditorScene();

    expect(landed).toBe(true);
  });

  it("does not block the navigation when the save fails — the editor reports that itself", async () => {
    registerSceneFlush(() => Promise.reject(new Error("backend down")));
    await expect(flushEditorScene()).resolves.toBeUndefined();
  });

  it("gives up after the timeout instead of stranding the user on the board", async () => {
    vi.useFakeTimers();
    registerSceneFlush(() => new Promise(() => {}));

    const leaving = flushEditorScene();
    let settled = false;
    void leaving.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await leaving;
    expect(settled).toBe(true);
  });

  it("forgets an unmounted editor, so a stale closure is never flushed", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    registerSceneFlush(flush);
    expect(hasEditorScene()).toBe(true);

    registerSceneFlush(null);
    await flushEditorScene();

    expect(flush).not.toHaveBeenCalled();
  });
});
