/**
 * The COLLAB load path (collab-plan phase 2 / phase-1 RETRO gate G-P2.2).
 *
 * 0.1.0 only ever swept the scene it read out of the vanilla `excalidraw` localStorage key, so a ghost could only
 * ever be this browser's own. In the fork the same scene is now shared: `Collab.initializeRoom` loads it from
 * `/api/rooms` through `euidosStorage.loadFromFirebase`, which means the scaffolding a PEER's interrupted take
 * left behind (and that peer's `PUT` persisted) is what arrives here. The wiring is one line in
 * `excalidraw-app/collab/Collab.tsx`:
 *
 *     const elements = stored && sweepGhostPlaceholders(stored);
 *
 * so what is actually worth testing is the contract that line relies on: the sweep is a pure function over a
 * remote element array, it composes with whatever `loadFromFirebase` hands back (a readonly array of elements
 * carrying the `SyncableExcalidrawElement` brand — extra fields it never reads), and its output is a scene the
 * reconciler can take. A peer's ghost must not survive the join; a peer's WORDS must.
 */
import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { sweepGhostPlaceholders } from "../persist";

/** Fields `loadFromFirebase` guarantees and the sweep must carry through untouched. */
type RemoteElement = ExcalidrawElement & { index: string; version: number };

const remote = (
  id: string,
  el: Record<string, unknown>,
  index: string,
): RemoteElement =>
  ({
    id,
    isDeleted: false,
    strokeStyle: "solid",
    boundElements: null,
    containerId: null,
    version: 7,
    index,
    ...el,
  } as unknown as RemoteElement);

/** What a peer's PUT can leave in `scenes.elements`: their finished words, plus their interrupted take. */
const remoteScene = (): RemoteElement[] => [
  remote("peer-rect", { type: "rectangle" }, "a0"),
  remote("peer-words", { type: "text", text: "the quarterly plan" }, "a1"),
  // The interrupted take: a dashed marker, its animation placeholder bound to it, and the interim preview the
  // peer's canvas was showing at 45 % when their tab went away.
  remote(
    "peer-marker",
    {
      type: "rectangle",
      strokeStyle: "dashed",
      customData: { voiceRegion: true },
      boundElements: [{ id: "peer-placeholder", type: "text" }],
    },
    "a2",
  ),
  remote(
    "peer-placeholder",
    { type: "text", text: "··", containerId: "peer-marker" },
    "a3",
  ),
  remote(
    "peer-interim",
    {
      type: "text",
      text: "so the second thing we",
      customData: { voiceInterim: true },
    },
    "a4",
  ),
  remote(
    "peer-warning",
    {
      type: "text",
      text: "⚠ STT unreachable",
      customData: { voiceFailed: true },
    },
    "a5",
  ),
];

const live = (els: readonly RemoteElement[]) =>
  els.filter((el) => !el.isDeleted).map((el) => el.id);

describe("the collab load path sweeps a peer's scaffolding (G-P2.2)", () => {
  it("drops the marker, the placeholder, the interim preview and the ⚠ a peer's interrupted take persisted", () => {
    const out = sweepGhostPlaceholders(remoteScene());

    expect(live(out)).toEqual(["peer-rect", "peer-words"]);
  });

  it("keeps the peer's committed transcript byte-for-byte, and its identity", () => {
    const before = remoteScene();
    const out = sweepGhostPlaceholders(before);

    const words = out.find((el) => el.id === "peer-words")!;
    // Untouched elements are passed through by reference: the reconciler compares versions, and a gratuitous copy
    // of every remote element on every join would be churn with a version bump behind it.
    expect(words).toBe(before[1]);
    expect((words as unknown as { text: string }).text).toBe(
      "the quarterly plan",
    );
  });

  it("carries the fields the reconciler needs (index, version) through a SWEPT element", () => {
    const out = sweepGhostPlaceholders(remoteScene());

    const marker = out.find((el) => el.id === "peer-marker")!;
    expect(marker.isDeleted).toBe(true);
    // Tombstoned, not removed: an element dropped from the array would be resurrected by the next peer's
    // reconcile, and one with no fractional index cannot be ordered.
    expect(marker.index).toBe("a2");
    expect(marker.version).toBe(7);
    expect(out).toHaveLength(6);
  });

  it("is idempotent, so a rejoin (or a second load) changes nothing further", () => {
    const once = sweepGhostPlaceholders(remoteScene());
    const twice = sweepGhostPlaceholders(once);

    expect(live(twice)).toEqual(live(once));
    expect(twice.map((el) => el.isDeleted)).toEqual(
      once.map((el) => el.isDeleted),
    );
  });

  it("leaves a remote scene that never saw the voice tool completely alone", () => {
    const plain = [
      remote("r1", { type: "rectangle" }, "a0"),
      remote("t1", { type: "text", text: "typed by hand" }, "a1"),
      // A founder-typed warning is NOT litter: only the app's own stamp makes one sweepable.
      remote("t2", { type: "text", text: "⚠ STT is down again" }, "a2"),
    ];

    const out = sweepGhostPlaceholders(plain);

    expect(live(out)).toEqual(["r1", "t1", "t2"]);
    expect(out).toEqual(plain);
  });
});
