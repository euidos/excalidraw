/**
 * The COLLAB load path (collab-plan phase 2 / phase-1 RETRO gate G-P2.2).
 *
 * 0.1.0 only ever swept the scene it read out of the vanilla `excalidraw` localStorage key, so a ghost could only
 * ever be this browser's own, and "delete it" meant "stop drawing it". In the fork the same scene is shared:
 * `Collab.initializeRoom` loads it from `/api/rooms` through `euidosStorage.loadFromFirebase`, so the scaffolding
 * that arrives here is a PEER's — and deleting it is a scene EDIT that has to travel. Two things follow, and both
 * are what this file pins:
 *
 *   1. a tombstone has to WIN. `reconcileElements` resolves a version tie on `local.versionNonce <= remote.
 *      versionNonce`, so a shallow `{ ...el, isDeleted: true }` (same version, same nonce) is discarded by every
 *      peer that still holds the element alive, and `getSceneVersion` — a plain sum of versions — does not even
 *      rise, so nothing is broadcast or saved in the first place. The sweep therefore goes through
 *      `newElementWith`, and the gates below run the REAL reconciler in both argument orders rather than
 *      asserting a field and hoping;
 *   2. a peer may be SPEAKING into that scaffolding right now. `keepRecentMs` is the collab call site's answer:
 *      an armed take rewrites its own placeholder ~3x/s, so `updated` is a heartbeat, and a group that is still
 *      beating is left alone.
 *
 * The wiring is two lines in `excalidraw-app/collab/Collab.tsx`; everything worth testing is in here.
 */
import { describe, expect, it } from "vitest";

import { getUpdatedTimestamp } from "@excalidraw/common";

import { reconcileElements } from "@excalidraw/excalidraw/data/reconcile";

import type {
  RemoteExcalidrawElement,
  ReconciledExcalidrawElement,
} from "@excalidraw/excalidraw/data/reconcile";

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

import type { AppState } from "@excalidraw/excalidraw/types";

import { LIVE_SCAFFOLDING_MS, sweepGhostPlaceholders } from "../persist";

/** Fields `loadFromFirebase` guarantees and the sweep must carry through untouched. */
type RemoteElement = ExcalidrawElement & { index: string; version: number };

/** Long enough ago that the liveness window cannot mistake it for a take in flight. */
const STALE = Date.now() - 10 * 60_000;

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
    versionNonce: 111,
    updated: STALE,
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

const byId = (
  els: readonly { id: string }[],
  id: string,
): Record<string, unknown> =>
  els.find((el) => el.id === id) as unknown as Record<string, unknown>;

/** The reconciler only reads the four "is the user busy with this element" ids off the app state. */
const appState = {
  editingTextElement: null,
  resizingElement: null,
  newElement: null,
} as unknown as AppState;

const reconcile = (
  local: readonly RemoteElement[],
  incoming: readonly RemoteElement[],
): ReconciledExcalidrawElement[] =>
  reconcileElements(
    local as unknown as readonly OrderedExcalidrawElement[],
    incoming as unknown as readonly RemoteExcalidrawElement[],
    appState,
  );

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

  it("carries the fields the reconciler needs (index) and BUMPS the ones it decides on", () => {
    const before = remoteScene();
    const out = sweepGhostPlaceholders(before);

    const marker = out.find((el) => el.id === "peer-marker")!;
    expect(marker.isDeleted).toBe(true);
    // Tombstoned, not removed: an element dropped from the array would be resurrected by the next peer's
    // reconcile, and one with no fractional index cannot be ordered.
    expect(marker.index).toBe("a2");
    expect(out).toHaveLength(6);
    // ...but a tombstone that keeps the original version/nonce LOSES every reconcile against a peer still holding
    // the element alive, and leaves getSceneVersion unchanged so it is never even sent. The bump is the fix.
    expect(marker.version).toBeGreaterThan(7);
    expect(marker.versionNonce).not.toBe(111);
    // `updated` must move too, or a ghost older than DELETED_ELEMENT_TIMEOUT (24 h) fails isSyncableElement and
    // the tombstone is stripped out of the PUT. Asserted against the library's own clock rather than a
    // comparison, because `getUpdatedTimestamp()` is pinned to 1 under vitest and to Date.now() in the app.
    expect(marker.updated).not.toBe(STALE);
    expect(marker.updated).toBe(getUpdatedTimestamp());
  });

  it("raises the scene version, which is the only reason Collab broadcasts or saves the sweep at all", () => {
    const before = remoteScene();
    const sum = (els: readonly RemoteElement[]) =>
      els.reduce((acc, el) => acc + el.version, 0);

    expect(sum(sweepGhostPlaceholders(before))).toBeGreaterThan(sum(before));
  });

  it("beats a peer that still holds the ghost alive, through the REAL reconciler, in both directions", () => {
    const stored = remoteScene();
    const swept = sweepGhostPlaceholders(stored);
    // The peer never reloaded, so its copy is the untouched one it loaded (and re-PUTs every ~14 s).
    const stillAlive = remoteScene();

    // (a) the peer RECEIVES our sweep: remote = our tombstones, local = its live ghosts.
    const received = reconcile(stillAlive, swept);
    expect(byId(received, "peer-marker").isDeleted).toBe(true);
    expect(byId(received, "peer-interim").isDeleted).toBe(true);
    // (b) the peer SAVES: euidosStorage passes the peer's own local elements as `local` and the stored scene as
    // `remote`, so the same tie-break decides whether the ghost is written straight back into the room.
    const saved = reconcile(swept, stillAlive);
    expect(byId(saved, "peer-marker").isDeleted).toBe(true);
    expect(byId(saved, "peer-warning").isDeleted).toBe(true);
    // ...and the words the peer never touched survive either way.
    expect(byId(received, "peer-words").isDeleted).toBe(false);
    expect(byId(saved, "peer-words").isDeleted).toBe(false);
  });

  it("unbinds a ghost from a founder-drawn container with a bump too, or the unbind loses the same way", () => {
    const scene: RemoteElement[] = [
      remote(
        "drawn-box",
        {
          type: "rectangle",
          strokeStyle: "dashed",
          boundElements: [{ id: "ghost", type: "text" }],
        },
        "a0",
      ),
      remote(
        "ghost",
        { type: "text", text: "·", containerId: "drawn-box" },
        "a1",
      ),
    ];

    const out = sweepGhostPlaceholders(scene);
    const box = out.find((el) => el.id === "drawn-box")!;

    // The founder's shape survives; only the scaffolding leaves it.
    expect(box.isDeleted).toBe(false);
    expect(box.boundElements).toBe(null);
    expect(box.strokeStyle).toBe("solid");
    expect(box.version).toBeGreaterThan(7);
    expect(box.versionNonce).not.toBe(111);
  });

  it("is idempotent, so a rejoin (or a second load) changes nothing further", () => {
    const once = sweepGhostPlaceholders(remoteScene());
    const twice = sweepGhostPlaceholders(once);

    expect(live(twice)).toEqual(live(once));
    expect(twice.map((el) => el.isDeleted)).toEqual(
      once.map((el) => el.isDeleted),
    );
    // No second bump either: an already-tombstoned element is passed through by reference, so a client that
    // rejoins in a loop cannot drive the scene version (and with it the broadcast/save traffic) up forever.
    expect(twice.map((el) => el.version)).toEqual(once.map((el) => el.version));
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

describe("keepRecentMs — a peer who is speaking RIGHT NOW is not swept (collab path only)", () => {
  /** The same interrupted take, except the placeholder is still ticking: someone is mid-utterance. */
  const speakingScene = (): RemoteElement[] =>
    remoteScene().map((el) =>
      el.id === "peer-placeholder"
        ? ({ ...el, updated: Date.now() } as RemoteElement)
        : el,
    );

  it("spares the whole take — marker included — while its placeholder is still beating", () => {
    const out = sweepGhostPlaceholders(speakingScene(), {
      keepRecentMs: LIVE_SCAFFOLDING_MS,
    });

    // The marker's own `updated` is stale (nothing touches it after pen-up); it survives because the placeholder
    // bound to it is alive. Grouping is the whole point: per-element freshness would delete the live region.
    expect(live(out)).toContain("peer-marker");
    expect(live(out)).toContain("peer-placeholder");
  });

  it("still sweeps the litter of takes that are NOT live in the same scene", () => {
    const out = sweepGhostPlaceholders(speakingScene(), {
      keepRecentMs: LIVE_SCAFFOLDING_MS,
    });

    expect(live(out)).not.toContain("peer-interim");
    expect(live(out)).not.toContain("peer-warning");
    expect(live(out)).toContain("peer-words");
  });

  it("sweeps it once the heartbeat has stopped for longer than the window", () => {
    const scene = speakingScene();
    const out = sweepGhostPlaceholders(scene, {
      keepRecentMs: LIVE_SCAFFOLDING_MS,
      now: Date.now() + LIVE_SCAFFOLDING_MS + 1_000,
    });

    expect(live(out)).toEqual(["peer-rect", "peer-words"]);
  });

  it("defaults to sweeping everything, which is what the LOCAL load path wants", () => {
    // Same scene, no option: this browser is the only client that could have been speaking, and it just reloaded.
    expect(live(sweepGhostPlaceholders(speakingScene()))).toEqual([
      "peer-rect",
      "peer-words",
    ]);
  });
});
