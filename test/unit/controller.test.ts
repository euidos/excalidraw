/**
 * Controller gates for the two round-2 attribution races, driven through the real state machine with fakes for
 * the four surfaces it talks to (scene API, capture, fit, STT). Both cases lost a whole sentence on the shipped
 * bundle and neither is reachable from the e2e suite without a sleep-shaped race, so they live here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The library's runtime entry pulls in browser-only modules; the controller uses exactly two of its exports.
vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", NEVER: "NEVER", EVENTUALLY: "EVENTUALLY" },
  newElementWith: (element: { version?: number }, updates: object) => ({
    ...element,
    ...updates,
    version: (element.version ?? 0) + 1,
  }),
}));

import { assignUtterance } from "../../src/assign";
import { createVoiceController, isSuperseded } from "../../src/controller";
import { DEFAULT_SETTINGS } from "../../src/contracts";
import type {
  FitModule,
  PlaceholderResult,
  Point,
  RecognizeStroke,
  StrokeShape,
  StyleSnapshot,
  Transcribe,
  VoiceController,
  VoiceSettings,
  VoiceStatus,
  VoiceTarget,
} from "../../src/contracts";
import type { StrokeRecord, VoiceCapture } from "../../src/contracts-capture";
import type { ExcalidrawElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const SENTENCE = "Ship the voice tool tonight";

/** jsdom is not in play (vitest runs in node) and the controller only needs a frame to exist. */
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number =>
    setTimeout(() => cb(Date.now()), 1) as unknown as number) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number): void => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }) as typeof globalThis.cancelAnimationFrame;
}

type El = ExcalidrawElement & { text?: string; containerId?: string | null; points?: number[][] };

const el = (fields: Partial<El> & { id: string; type: string }): El =>
  ({
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    isDeleted: false,
    version: 1,
    strokeStyle: "solid",
    ...fields,
  }) as unknown as El;

type DownHandler = (tool: { type: string }, pds: { origin: Point }) => void;

/** The scene, the app state and the two pointer subscriptions the controller installs. */
class FakeApi {
  elements: El[] = [];
  appState = {
    zoom: { value: 1 },
    newElement: null as El | null,
    activeTool: { type: "freedraw", locked: false },
    width: 1600,
    height: 900,
    scrollX: 0,
    scrollY: 0,
    currentItemStrokeColor: "#1e1e1e",
    currentItemBackgroundColor: "transparent",
    currentItemFillStyle: "solid",
    currentItemStrokeWidth: 2,
    currentItemStrokeStyle: "solid",
    currentItemRoughness: 1,
    currentItemOpacity: 100,
    currentItemRoundness: "round",
    currentItemFontFamily: 5,
  };
  down: DownHandler | null = null;
  up: (() => void) | null = null;

  api(): ExcalidrawImperativeAPI {
    return {
      getSceneElements: () => this.elements.filter((e) => !e.isDeleted),
      getSceneElementsIncludingDeleted: () => this.elements,
      updateScene: ({ elements }: { elements?: readonly El[] }) => {
        if (elements) this.elements = [...elements];
      },
      getAppState: () => this.appState as unknown as AppState,
      setActiveTool: () => undefined,
      setToast: () => undefined,
      onPointerDown: (cb: DownHandler) => {
        this.down = cb;
        return () => {
          this.down = null;
        };
      },
      onPointerUp: (cb: () => void) => {
        this.up = cb;
        return () => {
          this.up = null;
        };
      },
    } as unknown as ExcalidrawImperativeAPI;
  }

  find(id: string): El | undefined {
    return this.elements.find((e) => e.id === id);
  }
}

/** Ids are handed out in creation order so a test can name the container it expects the words in. */
let seq = 0;
const fakeFit = (): FitModule => {
  const placeholder = (shape: StrokeShape, containerId?: string): PlaceholderResult => {
    seq += 1;
    const cid = containerId ?? `container-${seq}`;
    const tid = `text-${seq}`;
    const container = el({ id: cid, type: "rectangle", strokeStyle: "dashed" });
    const text = el({ id: tid, type: "text", text: "·", containerId: cid });
    const target: VoiceTarget = { containerId: cid, textId: tid, shape };
    return { elements: [container, text], target };
  };
  return {
    buildPlaceholder: (shape: StrokeShape) => placeholder(shape),
    buildPlaceholderFor: (container: ExcalidrawElement) =>
      placeholder({ kind: "rectangle", x: 0, y: 0, width: 100, height: 60 }, container.id),
    setPlaceholderFrame: (text: ExcalidrawTextElement, frame: number) =>
      ({ ...text, text: ".".repeat((frame % 3) + 1) }) as ExcalidrawTextElement,
    commitText: (_t: VoiceTarget, container: ExcalidrawElement, text: ExcalidrawTextElement, transcript: string) => [
      { ...container, strokeStyle: "solid" } as ExcalidrawElement,
      { ...text, text: transcript, originalText: transcript } as ExcalidrawTextElement,
    ],
    markFailed: (_t: VoiceTarget, container: ExcalidrawElement, text: ExcalidrawTextElement) => [
      container,
      { ...text, text: "⚠ STT" } as ExcalidrawTextElement,
    ],
    discard: (_t: VoiceTarget, container: ExcalidrawElement, text: ExcalidrawTextElement) => [
      { ...container, strokeStyle: "solid" } as ExcalidrawElement,
      { ...text, isDeleted: true } as ExcalidrawTextElement,
    ],
    buildFreeText: (at: Point, transcript: string) => {
      seq += 1;
      return el({
        id: `free-${seq}`,
        type: "text",
        x: at.x,
        y: at.y,
        text: transcript,
        containerId: null,
      }) as unknown as ExcalidrawTextElement;
    },
  };
};

/** A capture whose clock the test drives, so pre-roll arithmetic is exact instead of wall-clock-approximate. */
class FakeCapture implements VoiceCapture {
  clock = 1000;
  mic: "ok" = "ok";
  active = false;
  onUtteranceStart?: VoiceCapture["onUtteranceStart"];
  onUtteranceEnd?: VoiceCapture["onUtteranceEnd"];
  onLevel?: VoiceCapture["onLevel"];
  onMicChange?: VoiceCapture["onMicChange"];
  async prepare(): Promise<"ok"> {
    return "ok";
  }
  async start(): Promise<void> {
    this.active = true;
  }
  async stop(): Promise<void> {
    this.active = false;
  }
  wav(): Blob {
    return new Blob(["pcm"], { type: "audio/wav" });
  }
  now(): number {
    return this.clock;
  }
  setVad(): void {}
  dispose(): void {}
}

const settings = (patch: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...DEFAULT_SETTINGS, ...patch });

const recognizeRect: RecognizeStroke = () => ({ kind: "rectangle", x: 0, y: 0, width: 100, height: 60 });

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await wait(5);
  }
}

interface Harness {
  api: FakeApi;
  capture: FakeCapture;
  controller: VoiceController;
  status: () => VoiceStatus;
  stroke: (id: string) => Promise<void>;
}

function harness(patch: Partial<VoiceSettings> = {}): Harness {
  const api = new FakeApi();
  const capture = new FakeCapture();
  const transcribe: Transcribe = async () => ({ text: SENTENCE, latencyMs: 1 });
  const controller = createVoiceController({
    api: api.api(),
    capture,
    assign: assignUtterance,
    transcribe,
    fit: fakeFit(),
    recognize: recognizeRect,
    getSettings: () => settings(patch),
    onStatus: () => undefined,
  });
  /** One whole pen stroke: the library inserts the element before pointerdown and finalises it after pointerup. */
  const stroke = async (id: string): Promise<void> => {
    const ink = el({ id, type: "freedraw", points: [[0, 0], [100, 0], [100, 60], [0, 60]] });
    api.elements.push(ink);
    api.appState.newElement = ink;
    api.down?.({ type: "freedraw" }, { origin: { x: 10, y: 10 } });
    api.up?.();
    api.appState.newElement = null;
    // convertStroke waits a tick plus a frame for the library to finalise the element.
    await until(() => api.elements.some((e) => e.type === "rectangle" && !e.isDeleted && e.id !== id));
  };
  return { api, capture, controller, status: () => controller.getStatus(), stroke };
}

let live: VoiceController | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

describe("isSuperseded — when a later stroke takes the open speech away from an earlier one", () => {
  const preRoll = 1500;

  it("does NOT supersede while an open utterance predates the later stroke's pre-roll window", () => {
    const strokes: StrokeRecord[] = [
      { id: "own", downMs: 1000 },
      { id: "later", downMs: 3000 },
    ];
    // onset 1100: the later stroke's window opens at 1500, so assign.ts still gives this utterance to "own".
    expect(isSuperseded(1000, strokes, [1100], preRoll)).toBe(false);
    expect(assignUtterance({ id: 1, onsetMs: 1100, endMs: 5000 }, strokes, Infinity, { preRollMs: preRoll }).strokeId).toBe(
      "own",
    );
  });

  it("supersedes when the later stroke outranks it for every open utterance", () => {
    const strokes: StrokeRecord[] = [
      { id: "own", downMs: 1000 },
      { id: "later", downMs: 3000 },
    ];
    expect(isSuperseded(1000, strokes, [2000], preRoll)).toBe(true);
    expect(assignUtterance({ id: 1, onsetMs: 2000, endMs: 5000 }, strokes, Infinity, { preRollMs: preRoll }).strokeId).toBe(
      "later",
    );
  });

  it("supersedes with nothing open at all: only future speech is left, and a future onset always favours the later stroke", () => {
    expect(isSuperseded(1000, [{ id: "later", downMs: 3000 }], [], preRoll)).toBe(true);
  });

  it("one open utterance out of several is enough to keep the target", () => {
    const strokes: StrokeRecord[] = [
      { id: "own", downMs: 1000 },
      { id: "later", downMs: 3000 },
    ];
    expect(isSuperseded(1000, strokes, [2000, 1100], preRoll)).toBe(false);
  });

  it("agrees with assign.ts on every combination it claims", () => {
    for (const ownDown of [0, 500, 1000]) {
      for (const laterDown of [600, 1200, 2600, 4000]) {
        for (const onset of [0, 400, 1000, 2000, 3000]) {
          const strokes: StrokeRecord[] = [
            { id: "own", downMs: ownDown },
            { id: "later", downMs: laterDown },
          ];
          if (laterDown <= ownDown) continue;
          const winner = assignUtterance({ id: 1, onsetMs: onset, endMs: onset + 1 }, strokes, Infinity, {
            preRollMs: preRoll,
          }).strokeId;
          // Superseded ⇔ the later stroke would win the open utterance; never discard a target that still wins one.
          expect(isSuperseded(ownDown, strokes, [onset], preRoll)).toBe(winner === "later");
        }
      }
    }
  });
});

describe("the controller keeps a target whose speech is still open", () => {
  it("does not discard an empty target while an utterance older than the next stroke's window is unclosed", async () => {
    const h = harness();
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const containerA = h.api.elements.find((e) => e.type === "rectangle")!.id;

    // A long sentence starts 100 ms after stroke A and is still running.
    h.capture.clock = 1100;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1100 });

    // Stroke B lands 1.9 s later — outside the open utterance's pre-roll window, so A still owns that speech.
    h.capture.clock = 3000;
    await h.stroke("ink-b");

    // A short cough resolves in between: this is what makes the controller re-examine every open target.
    h.capture.clock = 3100;
    h.capture.onUtteranceStart?.({ id: 2, onsetMs: 3100 });
    h.capture.clock = 5000;
    h.capture.onUtteranceEnd?.({ id: 2, onsetMs: 3100, endMs: 3105 });
    await wait(50);

    // Now the long sentence ends and must still find its shape.
    h.capture.clock = 6000;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1100, endMs: 5900 });

    await until(() => h.status().completed === 1, 3000);
    const committed = h.api.elements.find((e) => e.text === SENTENCE);
    expect(committed, "the sentence was written somewhere").toBeTruthy();
    expect(committed!.containerId, "…and into the shape drawn for it, not a free-text orphan").toBe(containerA);
    expect(h.status().orphans).toBe(0);
  });
});

describe("the controller never hands an utterance to a shape that has left the scene", () => {
  it("prunes the undone stroke and places the words as an orphan instead of dropping them", async () => {
    const h = harness();
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const container = h.api.elements.find((e) => e.type === "rectangle")!;
    const text = h.api.elements.find((e) => e.containerId === container.id)!;

    // Ctrl+Z before speaking: the placeholder pair leaves the scene, the stroke record does not.
    h.api.elements = h.api.elements.map((e) =>
      e.id === container.id || e.id === text.id ? ({ ...e, isDeleted: true } as El) : e,
    );

    h.capture.clock = 1200;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1200 });
    h.capture.clock = 5000;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1200, endMs: 3200 });

    await until(() => h.status().completed === 1, 3000);
    expect(h.status().orphans, "the utterance fell through to the orphan path").toBe(1);
    expect(h.status().lastTranscript).toBe(SENTENCE);
    const placed = h.api.elements.filter((e) => !e.isDeleted && e.text === SENTENCE);
    expect(placed, "exactly one free text carries the sentence").toHaveLength(1);
    expect(placed[0]!.containerId ?? null, "it is free text, not bound to the undone shape").toBeNull();
  });
});
