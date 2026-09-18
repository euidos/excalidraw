/**
 * Controller gates for the two round-2 attribution races, driven through the real state machine with fakes for
 * the four surfaces it talks to (scene API, capture, fit, STT). Both cases lost a whole sentence on the shipped
 * bundle and neither is reachable from the e2e suite without a sleep-shaped race, so they live here.
 */
/* eslint-disable import/first -- the imports deliberately follow vi.mock: the mock IS the first thing
   this file says about the library, and vitest hoists it regardless of where the imports sit. */
import { afterEach, describe, expect, it, vi } from "vitest";

// The library's runtime entry pulls in browser-only modules; the controller uses exactly two of its exports.
vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: {
    IMMEDIATELY: "IMMEDIATELY",
    NEVER: "NEVER",
    EVENTUALLY: "EVENTUALLY",
  },
  newElementWith: (element: { version?: number }, updates: object) => ({
    ...element,
    ...updates,
    version: (element.version ?? 0) + 1,
  }),
}));

import { pointFrom } from "@excalidraw/math";

import type { LocalPoint } from "@excalidraw/math";

import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";

import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { assignUtterance } from "../assign";
import { createVoiceController, isSuperseded } from "../controller";
import { DEFAULT_SETTINGS } from "../contracts";

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
} from "../contracts";
import type { StrokeRecord, VoiceCapture } from "../contracts-capture";

const SENTENCE = "Ship the voice tool tonight";

/** jsdom is not in play (vitest runs in node) and the controller only needs a frame to exist. */
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number =>
    setTimeout(
      () => cb(Date.now()),
      1,
    ) as unknown as number) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number): void => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }) as typeof globalThis.cancelAnimationFrame;
}

type El = ExcalidrawElement & {
  text?: string;
  containerId?: string | null;
  points?: number[][];
  customData?: Record<string, unknown>;
};

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
  } as unknown as El);

type DownHandler = (tool: { type: string }, pds: { origin: Point }) => void;

/** The scene, the app state and the two pointer subscriptions the controller installs. */
class FakeApi {
  elements: El[] = [];
  /** Every toast the controller raised, in order: the only rendered sink a drop has (gate N10). */
  toasts: { message: string; duration?: number }[] = [];
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
    // master: a StrokeWidthKey, resolved to scene px by snapshotStyle ("medium" === the old 2).
    currentItemStrokeWidthKey: "medium",
    currentItemStrokeStyle: "solid",
    currentItemRoughness: 1,
    currentItemOpacity: 100,
    currentItemRoundness: "round",
    currentItemFontFamily: 5,
  };
  down: DownHandler | null = null;
  up: (() => void) | null = null;
  /** Every scene write with the captureUpdate it carried: the undo-checkpoint rule is only visible here. */
  writes: { captureUpdate: string; elements: El[] }[] = [];

  api(): ExcalidrawImperativeAPI {
    return {
      getSceneElements: () => this.elements.filter((e) => !e.isDeleted),
      getSceneElementsIncludingDeleted: () => this.elements,
      updateScene: ({
        elements,
        captureUpdate,
      }: {
        elements?: readonly El[];
        captureUpdate?: string;
      }) => {
        if (elements) {
          this.elements = [...elements];
        }
        this.writes.push({
          captureUpdate: captureUpdate ?? "",
          elements: elements ? [...elements] : [],
        });
      },
      getAppState: () => this.appState as unknown as AppState,
      setActiveTool: () => undefined,
      setToast: (toast: { message: string; duration?: number } | null) => {
        if (toast) {
          this.toasts.push(toast);
        }
      },
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

/** Ids are handed out in creation order so a test can name the region the words are expected in. */
let seq = 0;
/**
 * A fit module that only obeys the round-4a contract: a region MARKER plus a placeholder while pending, and a
 * commit that frees the text and deletes the marker in the same update.
 */
const fakeFit = (): FitModule => {
  const placeholder = (
    shape: StrokeShape,
    markerId?: string,
  ): PlaceholderResult => {
    seq += 1;
    const mid = markerId ?? `marker-${seq}`;
    const tid = `text-${seq}`;
    const marker = el({
      id: mid,
      type: "rectangle",
      strokeStyle: "dashed",
      customData: { voiceRegion: true },
    });
    const text = el({ id: tid, type: "text", text: "·", containerId: mid });
    const target: VoiceTarget = { markerId: mid, textId: tid, shape };
    return { elements: [marker, text], target };
  };
  return {
    buildPlaceholder: (shape: StrokeShape) => placeholder(shape),
    buildPlaceholderFor: (container: ExcalidrawElement) =>
      placeholder(
        { kind: "rectangle", x: 0, y: 0, width: 100, height: 60 },
        container.id,
      ),
    setPlaceholderFrame: (text: ExcalidrawTextElement, frame: number) =>
      ({ ...text, text: ".".repeat((frame % 3) + 1) } as ExcalidrawTextElement),
    commitText: (
      _t: VoiceTarget,
      text: ExcalidrawTextElement,
      transcript: string,
      _style: StyleSnapshot,
      marker?: ExcalidrawElement | null,
    ) => {
      // Like the real fit.commitText: a commit CLEARS both stamps, or the next reload's sweep would eat the words.
      const {
        voiceInterim: _i,
        voiceFailed: _f,
        ...rest
      } = (text.customData ?? {}) as Record<string, unknown>;
      return [
        {
          ...text,
          text: transcript,
          originalText: transcript,
          containerId: null,
          opacity: 100,
          customData: rest,
        } as ExcalidrawTextElement,
        ...(marker
          ? [{ ...marker, isDeleted: true } as ExcalidrawElement]
          : []),
      ];
    },
    // Round 5: a preview keeps the marker and stamps the text; the reset puts the dot back and clears the stamp.
    commitInterim: (
      _t: VoiceTarget,
      text: ExcalidrawTextElement,
      transcript: string,
    ) => [
      {
        ...text,
        text: transcript,
        originalText: transcript,
        opacity: 45,
        customData: { ...(text.customData ?? {}), voiceInterim: true },
      } as ExcalidrawTextElement,
    ],
    resetPlaceholder: (
      _t: VoiceTarget,
      _marker: ExcalidrawElement | null,
      text: ExcalidrawTextElement,
    ) => {
      const { voiceInterim: _drop, ...rest } = (text.customData ??
        {}) as Record<string, unknown>;
      return [
        {
          ...text,
          text: "·",
          originalText: "·",
          opacity: 100,
          customData: rest,
        } as ExcalidrawTextElement,
      ];
    },
    markFailed: (
      _t: VoiceTarget,
      marker: ExcalidrawElement | null,
      text: ExcalidrawTextElement,
    ) => {
      // The REAL guard (fit.ts hasLandedTranscript), which this fake omitted until round 5b: landed words are the
      // only copy the founder has, so a later failure writes nothing over them — while a placeholder dot, an
      // earlier ⚠ and an interim PREVIEW are all scaffolding a warning may replace. Without the guard here, the
      // must-level defect of round 5 (a failure after a preview reported nothing at all) was invisible to the suite.
      const content = String(text.originalText ?? text.text ?? "").trim();
      const stamps = (text.customData ?? {}) as Record<string, unknown>;
      const scaffolding =
        content === "" ||
        /^\u00b7{1,3}$/.test(content) ||
        content.startsWith("⚠ STT") ||
        stamps.voiceInterim === true;
      if (!scaffolding) {
        return [];
      }
      const { voiceInterim: _drop, ...rest } = stamps;
      return [
        ...(marker ? [marker] : []),
        {
          ...text,
          text: "⚠ STT",
          originalText: "⚠ STT",
          opacity: 100,
          customData: { ...rest, voiceFailed: true },
        } as ExcalidrawTextElement,
      ];
    },
    discard: (
      _t: VoiceTarget,
      marker: ExcalidrawElement | null,
      text: ExcalidrawTextElement,
    ) => [
      { ...text, isDeleted: true } as ExcalidrawTextElement,
      ...(marker ? [{ ...marker, isDeleted: true } as ExcalidrawElement] : []),
    ],
    warmFonts: async () => undefined,
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
  noiseFloor = 0;
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

const settings = (patch: Partial<VoiceSettings> = {}): VoiceSettings => ({
  ...DEFAULT_SETTINGS,
  ...patch,
});

interface SttCall {
  signal?: AbortSignal;
  /** Set when the promise has been answered, so a test can assert "this one was never resolved". */
  done: boolean;
  answer: (text: string) => void;
  reject: (err: unknown) => void;
}
/**
 * A transcribe the test answers by hand. Round 5's whole claim is about WHEN the request leaves and WHEN its answer
 * is used, so the round trip has to be a thing the test opens and closes, not a resolved promise.
 */
function scriptedTranscribe(): { calls: SttCall[]; fn: Transcribe } {
  const calls: SttCall[] = [];
  const fn: Transcribe = (_blob, _opts, signal) =>
    new Promise((resolve, reject) => {
      const call: SttCall = {
        signal,
        done: false,
        answer: (text: string) => {
          call.done = true;
          resolve({ text, latencyMs: 7 });
        },
        reject: (err: unknown) => {
          call.done = true;
          reject(err);
        },
      };
      calls.push(call);
    });
  return { calls, fn };
}

const recognizeRect: RecognizeStroke = () => ({
  kind: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("condition never became true");
    }
    await wait(5);
  }
}

interface Harness {
  api: FakeApi;
  capture: FakeCapture;
  controller: VoiceController;
  status: () => VoiceStatus;
  stroke: (id: string) => Promise<void>;
  /** Pen down only: the stroke stays open, which is what gate N2e needs (the deadline passes mid-stroke). */
  strokeDown: (id: string) => void;
  /** Pen up for the stroke `strokeDown` opened, resolved once the conversion has produced its region. */
  strokeUp: (id: string) => Promise<void>;
}

function harness(
  patch: Partial<VoiceSettings> = {},
  transcribe: Transcribe = async () => ({
    text: SENTENCE,
    latencyMs: 1,
  }),
): Harness {
  const api = new FakeApi();
  const capture = new FakeCapture();
  // Every pre-round-5 case is about the FINAL transcript; interim slices are opted into per case so the older
  // gates keep measuring exactly what they measured before.
  const base: Partial<VoiceSettings> = { interimMs: 0, ...patch };
  const controller = createVoiceController({
    api: api.api(),
    capture,
    assign: assignUtterance,
    transcribe,
    fit: fakeFit(),
    recognize: recognizeRect,
    getSettings: () => settings(base),
    onStatus: () => undefined,
  });
  /** The library inserts the element into the scene before onPointerDown fires. */
  const strokeDown = (id: string): void => {
    // 0.18.1 typed freedraw points as plain number pairs; master brands them LocalPoint, so the
    // fixture is built through the library's own constructor instead of a bare literal.
    const points = (
      [
        [0, 0],
        [100, 0],
        [100, 60],
        [0, 60],
      ] as const
    ).map(([x, y]) => pointFrom<LocalPoint>(x, y));
    const ink = el({ id, type: "freedraw", points });
    api.elements.push(ink);
    api.appState.newElement = ink;
    api.down?.({ type: "freedraw" }, { origin: { x: 10, y: 10 } });
  };
  /** Counts markers including the deleted ones: a take can commit (and delete its marker) before the poll runs. */
  const markerCount = (): number =>
    api.elements.filter((e) => e.type === "rectangle").length;
  const strokeUp = async (id: string): Promise<void> => {
    void id;
    const before = markerCount();
    api.up?.();
    api.appState.newElement = null;
    // convertStroke waits a tick plus a frame for the library to finalise the element; count, so a second stroke
    // does not resolve on the FIRST stroke's marker.
    await until(() => markerCount() > before);
  };
  /** One whole pen stroke: down, up, region. */
  const stroke = async (id: string): Promise<void> => {
    strokeDown(id);
    await strokeUp(id);
  };
  return {
    api,
    capture,
    controller,
    status: () => controller.getStatus(),
    stroke,
    strokeDown,
    strokeUp,
  };
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
    expect(
      assignUtterance(
        { id: 1, onsetMs: 1100, endMs: 5000 },
        strokes,
        Infinity,
        { preRollMs: preRoll },
      ).strokeId,
    ).toBe("own");
  });

  it("supersedes when the later stroke outranks it for every open utterance", () => {
    const strokes: StrokeRecord[] = [
      { id: "own", downMs: 1000 },
      { id: "later", downMs: 3000 },
    ];
    expect(isSuperseded(1000, strokes, [2000], preRoll)).toBe(true);
    expect(
      assignUtterance(
        { id: 1, onsetMs: 2000, endMs: 5000 },
        strokes,
        Infinity,
        { preRollMs: preRoll },
      ).strokeId,
    ).toBe("later");
  });

  it("supersedes with nothing open at all: only future speech is left, and a future onset always favours the later stroke", () => {
    expect(
      isSuperseded(1000, [{ id: "later", downMs: 3000 }], [], preRoll),
    ).toBe(true);
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
          if (laterDown <= ownDown) {
            continue;
          }
          const winner = assignUtterance(
            { id: 1, onsetMs: onset, endMs: onset + 1 },
            strokes,
            Infinity,
            {
              preRollMs: preRoll,
            },
          ).strokeId;
          // Superseded ⇔ the later stroke would win the open utterance; never discard a target that still wins one.
          expect(isSuperseded(ownDown, strokes, [onset], preRoll)).toBe(
            winner === "later",
          );
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
    const markerA = h.api.elements.find((e) => e.type === "rectangle")!.id;
    // The words belong to the region A selected, and the region's identity is its placeholder TEXT: the marker is
    // deleted by the commit, so an id comparison against a live container would have nothing to compare to.
    const textA = h.api.elements.find((e) => e.containerId === markerA)!.id;

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
    expect(
      committed!.id,
      "…in the region drawn for it, not as a free-text orphan",
    ).toBe(textA);
    expect(
      committed!.containerId ?? null,
      "and it is free text: the marker it was fitted in is gone",
    ).toBeNull();
    expect(
      h.api.find(markerA)!.isDeleted,
      "the region marker left with the commit",
    ).toBe(true);
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
      e.id === container.id || e.id === text.id
        ? ({ ...e, isDeleted: true } as El)
        : e,
    );

    h.capture.clock = 1200;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1200 });
    h.capture.clock = 5000;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1200, endMs: 3200 });

    await until(() => h.status().completed === 1, 3000);
    expect(
      h.status().orphans,
      "the utterance fell through to the orphan path",
    ).toBe(1);
    expect(h.status().lastTranscript).toBe(SENTENCE);
    const placed = h.api.elements.filter(
      (e) => !e.isDeleted && e.text === SENTENCE,
    );
    expect(placed, "exactly one free text carries the sentence").toHaveLength(
      1,
    );
    expect(
      placed[0]!.containerId ?? null,
      "it is free text, not bound to the undone shape",
    ).toBeNull();
  });
});

describe("a dropped transcript is rendered, not only counted (gate N10)", () => {
  it("toasts the filtered text so a blocklist hit cannot be mistaken for a silent room", async () => {
    const h = harness({}, async () => ({
      text: "Subtitles by amara.org",
      latencyMs: 1,
    }));
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    h.capture.clock = 1200;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1200 });
    h.capture.clock = 5000;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1200, endMs: 3200 });

    await until(() => h.status().dropped === 1, 3000);
    expect(h.status().lastDropped).toBe("Subtitles by amara.org");
    const drop = h.api.toasts.find((t) => t.message.startsWith("Filtered:"));
    expect(drop, "the filter has a rendered sink").toBeTruthy();
    expect(drop!.message).toBe('Filtered: "Subtitles by amara.org"');
    expect(drop!.duration).toBe(2500);
    expect(h.status().completed, "and nothing was written into the shape").toBe(
      0,
    );
  });

  it("toasts a shape that ends with no text at all", async () => {
    const h = harness();
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    // Nothing is ever said: the disarm discards the placeholder, which is the moment the founder needs told.
    h.controller.toggleLatch();

    await until(
      () =>
        h.api.toasts.some(
          (t) => t.message === "No speech heard for that shape",
        ),
      3000,
    );
    expect(h.api.toasts.at(-1)!.duration).toBe(2500);
  });
});

describe("a failed entry whose shape has left the scene is pruned", () => {
  /** Slow enough that `pending` is observable, so no case has to sleep to know the round trip is over. */
  const boom: Transcribe = async () => {
    await wait(20);
    throw new Error("STT server unreachable");
  };

  /** One stroke, one utterance whose pre-roll deadline has already passed, dispatched and failed. */
  async function failOne(h: Harness, id: number, ink: string): Promise<void> {
    const base = 5000 * id;
    h.capture.clock = base;
    await h.stroke(ink);
    h.capture.clock = base + 200;
    h.capture.onUtteranceStart?.({ id, onsetMs: base + 200 });
    h.capture.clock = base + 4000; // past onset + preRoll, so the assignment is final
    h.capture.onUtteranceEnd?.({ id, onsetMs: base + 200, endMs: base + 1200 });
    await until(() => h.status().failed >= 1, 3000);
  }

  function deleteAll(h: Harness): void {
    h.api.elements = h.api.elements.map(
      (e) => ({ ...e, isDeleted: true } as El),
    );
  }

  it("drops it when the scene is next resolved, so failed count and audio do not grow", async () => {
    const h = harness({}, boom);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    await failOne(h, 1, "ink-a");
    expect(h.status().failed).toBe(1);

    // The founder undoes the shape rather than retrying it: the ⚠ and its audio have nowhere to go back to.
    deleteAll(h);
    h.controller.toggleLatch(); // disarm runs resolveTargets over the session

    await until(() => h.status().failed === 0, 3000);
    expect(
      h.status().failed,
      "the retry button must not stay lit for a shape that is gone",
    ).toBe(0);
  });

  it("drops an attempt-exhausted entry on retry instead of keeping it forever", async () => {
    const h = harness({}, boom);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    await failOne(h, 1, "ink-a");
    // Burn the three attempts: past MAX_ATTEMPTS retryFailed() skips the entry, so nothing else would remove it.
    for (let i = 0; i < 2; i++) {
      h.controller.retryFailed();
      await until(
        () => h.status().pending === 0 && h.status().failed === 1,
        3000,
      );
    }
    h.controller.retryFailed();
    expect(
      h.status().pending,
      "attempts are exhausted; no fourth request",
    ).toBe(0);
    expect(h.status().failed).toBe(1);

    deleteAll(h);
    h.controller.retryFailed();

    expect(
      h.status().failed,
      "nothing left to retry, so nothing left to show",
    ).toBe(0);
    expect(h.status().pending, "and no request was sent into the void").toBe(0);
  });
});

describe("gate N2e — a stroke that is still under the pen when the deadline passes", () => {
  /**
   * The defect this pins was destructive: speech, then a careful stroke that is still being drawn when the
   * utterance's pre-roll deadline expires. The stroke record is only created by convertStroke (which the pointer-UP
   * queues), so the assignment used to be finalised against a stroke list that did not contain the region the
   * founder was drawing for those very words: they orphaned at the pen origin AND the box was deleted with a
   * "No speech heard for that shape" toast. Unreachable from the e2e — the slowest stroke there is ~0.4 s of
   * pen-down against a 1.5 s pre-roll — so the barrier is gated here.
   */
  it("waits for the pen, then writes the words into the region being drawn", async () => {
    const h = harness({ preRollMs: 200 });
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    // The label is spoken first; the pen goes down inside its pre-roll window (1000 + 200) and is STILL DOWN when
    // both the utterance and the window have ended, which is the whole race.
    h.capture.clock = 1000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1000 });
    h.capture.clock = 1150;
    h.strokeDown("ink-a");
    h.capture.clock = 1600;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1000, endMs: 1500 });
    // The deadline is long past (1200) and its final timer has fired, with the pen still on the panel.
    await wait(60);
    expect(
      h.status().orphans,
      "nothing is finalised while a stroke is open",
    ).toBe(0);
    expect(h.status().completed).toBe(0);

    await h.strokeUp("ink-a");
    await until(() => h.status().completed === 1, 3000);

    const marker = h.api.elements.find(
      (e) => e.type === "rectangle" && e.customData?.voiceRegion === true,
    )!;
    const committed = h.api.elements.find(
      (e) => !e.isDeleted && e.text === SENTENCE,
    )!;
    expect(committed, "the words landed").toBeTruthy();
    expect(
      committed.containerId ?? null,
      "as free text, the marker having been removed",
    ).toBeNull();
    expect(h.status().orphans, "and not as an orphan at the pen origin").toBe(
      0,
    );
    expect(
      marker.isDeleted,
      "the marker left with its transcript, which is the only reason it may go",
    ).toBe(true);
    expect(
      h.api.toasts.some((t) => t.message === "No speech heard for that shape"),
      "nothing was ever discarded, so nothing said the founder was not heard",
    ).toBe(false);
  });
});

describe("a region the founder drew and never spoke into", () => {
  it("survives on the canvas while the tool stays latched, and only the disarm removes it", async () => {
    const h = harness({ preRollMs: 200 });
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const markerA = h.api.elements.find((e) => e.type === "rectangle")!.id;
    h.capture.clock = 2000;
    await h.stroke("ink-b");

    // One label, spoken late: assign.ts gives it to stroke B, which supersedes A for good.
    h.capture.clock = 4000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 4000 });
    h.capture.clock = 4700;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 4000, endMs: 4700 });
    await until(() => h.status().completed === 1, 3000);

    expect(
      h.api.find(markerA)!.isDeleted,
      "the box drawn before the label is still the founder's",
    ).toBe(false);
    expect(
      h.api.toasts.some((t) => t.message === "No speech heard for that shape"),
      "and nothing claimed it was removed",
    ).toBe(false);

    h.controller.toggleLatch();
    await until(() => h.api.find(markerA)!.isDeleted, 3000);
    expect(
      h.api.toasts.at(-1)!.message,
      "the sweep says so once, at the end of the take",
    ).toBe("No speech heard for that shape");
  });

  it("sweeps several at once with a toast that counts them", async () => {
    const h = harness();
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    h.capture.clock = 2000;
    await h.stroke("ink-b");
    h.capture.clock = 3000;
    await h.stroke("ink-c");
    const markers = h.api.elements
      .filter((e) => e.customData?.voiceRegion === true)
      .map((e) => e.id);
    expect(markers, "three regions, nothing said").toHaveLength(3);

    h.controller.toggleLatch();
    await until(() => markers.every((id) => h.api.find(id)!.isDeleted), 3000);
    expect(h.api.toasts.at(-1)!.message).toBe(
      "3 regions removed \u2014 nothing was said",
    );
  });
});

describe("a failure never overwrites words that already landed", () => {
  it("leaves an orphan's transcript alone when a later take into it fails", async () => {
    let calls = 0;
    const h = harness({}, async () => {
      calls += 1;
      if (calls === 1) {
        return { text: SENTENCE, latencyMs: 1 };
      }
      await wait(10);
      throw new Error("STT server unreachable");
    });
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    // No stroke at all: both utterances land in the same orphan free text.
    h.capture.clock = 1000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1000 });
    h.capture.clock = 4000;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1000, endMs: 2000 });
    await until(() => h.status().completed === 1, 3000);
    const written = h.api.elements.find(
      (e) => !e.isDeleted && e.text === SENTENCE,
    )!;

    h.capture.clock = 5000;
    h.capture.onUtteranceStart?.({ id: 2, onsetMs: 5000 });
    h.capture.clock = 8000;
    h.capture.onUtteranceEnd?.({ id: 2, onsetMs: 5000, endMs: 6000 });
    await until(() => h.status().failed === 1, 3000);

    expect(
      h.api.find(written.id)!.text,
      "the words are the only copy there is",
    ).toBe(SENTENCE);
    expect(
      h.status().failed,
      "the failure is reported by the retry button instead",
    ).toBe(1);
  });
});

/**
 * Round 5. The founder's complaint was a WAIT: "speech recognition shouldn't make you wait until after you finish
 * drawing the region". The cause was structural — the STT request was only sent from the assignment path, which is
 * blocked by the pre-roll window and by the pen-down flush barrier (gate N2e) — so these cases assert the two halves
 * of a take are now independent, and that the place they meet (`settle`) does not care which arrived first.
 */
describe("R5 — the transcript is requested at the utterance end, not at the assignment", () => {
  it("sends the audio while the pen is still down, and lands the words when the region appears", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 200 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    // The label is spoken first and the pen goes down inside its pre-roll window — the N2e shape, which is exactly
    // the rhythm the complaint is about.
    h.capture.clock = 1000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1000 });
    h.capture.clock = 1150;
    h.strokeDown("ink-a");
    h.capture.clock = 1600;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1000, endMs: 1500 });

    // THE GATE: the request is in flight although the pen has not been lifted and no region exists yet.
    await until(() => stt.calls.length === 1, 1000);
    expect(
      h.status().pending,
      "the round trip is counted as work in flight",
    ).toBe(1);
    expect(
      h.status().completed,
      "and nothing has been written: there is no region yet",
    ).toBe(0);

    // The server answers while the founder is still drawing.
    stt.calls[0]!.answer(SENTENCE);
    await wait(30);
    expect(
      h.status().completed,
      "the words wait for the region, not for the server",
    ).toBe(0);
    expect(h.status().pending, "the round trip is over, though").toBe(0);

    await h.strokeUp("ink-a");
    await until(() => h.status().completed === 1, 3000);
    const committed = h.api.elements.find(
      (e) => !e.isDeleted && e.text === SENTENCE,
    )!;
    expect(committed, "the words landed").toBeTruthy();
    expect(
      committed.containerId ?? null,
      "as free text: the marker left with the commit",
    ).toBeNull();
    expect(h.status().orphans, "and not as an orphan at the pen origin").toBe(
      0,
    );
    expect(
      h.status().lastSttLatencyMs,
      "the round trip is reported for comparison",
    ).toBe(7);
  });

  it("settles the same take when the ASSIGNMENT is the half that arrives first", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 200 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    // Region first, then speech: the assignment is final the moment the utterance closes, so the transcript is the
    // half that is missing.
    h.capture.clock = 1000;
    await h.stroke("ink-a");
    h.capture.clock = 1200;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1200 });
    h.capture.clock = 3000;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1200, endMs: 2500 });

    await until(() => stt.calls.length === 1, 1000);
    expect(
      h.status().completed,
      "nothing to write yet: the server has not answered",
    ).toBe(0);
    stt.calls[0]!.answer(SENTENCE);
    await until(() => h.status().completed === 1, 3000);

    // Idempotence: the disarm re-runs assignment and resolution over the whole session, which calls settle again
    // for an utterance that is already done. It must not write, count or commit a second time.
    h.controller.toggleLatch();
    await wait(80);
    expect(h.status().completed, "settle is idempotent").toBe(1);
    expect(
      h.api.elements.filter((e) => !e.isDeleted && e.text === SENTENCE),
      "exactly one text carries the sentence",
    ).toHaveLength(1);
    expect(stt.calls.length, "and no second request was sent").toBe(1);
  });

  it("a failure that arrives before the assignment lands as ⚠ STT on the final region, and retries", async () => {
    let calls = 0;
    const h = harness({ preRollMs: 200 }, async () => {
      calls += 1;
      if (calls === 1) {
        await wait(5);
        throw new Error("STT server unreachable");
      }
      return { text: SENTENCE, latencyMs: 3 };
    });
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1000 });
    h.capture.clock = 1150;
    h.strokeDown("ink-a");
    h.capture.clock = 1600;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1000, endMs: 1500 });
    // The failure happens with the pen down and no region in existence: it has nowhere to be reported yet.
    await until(() => calls === 1, 1000);
    await wait(30);
    expect(
      h.status().failed,
      "a failure with no region is not a failed region yet",
    ).toBe(0);

    await h.strokeUp("ink-a");
    await until(() => h.status().failed === 1, 3000);
    const warned = h.api.elements.find(
      (e) => !e.isDeleted && e.text === "⚠ STT",
    )!;
    expect(
      warned,
      "the warning is in the region the assignment finally chose",
    ).toBeTruthy();

    h.controller.retryFailed();
    await until(() => h.status().completed === 1, 3000);
    expect(
      h.api.find(warned.id)!.text,
      "the retry re-sent the audio it kept and the words landed",
    ).toBe(SENTENCE);
    expect(h.status().failed).toBe(0);
  });
});

describe("R5 — interim slices while the founder is still speaking", () => {
  /** onset one second behind the clock, so the first slice is due after `interimMs` rather than after the warm-up. */
  const OPEN_ONSET = 1000;

  it("previews the words so far in the provisional region, then the final transcript replaces them", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 200, interimMs: 40 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const markerA = h.api.elements.find((e) => e.type === "rectangle")!.id;
    const textA = h.api.elements.find((e) => e.containerId === markerA)!.id;

    h.capture.clock = OPEN_ONSET + 1000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: OPEN_ONSET + 900 });

    await until(() => stt.calls.length === 1, 2000);
    stt.calls[0]!.answer("Ship the");
    await until(() => h.api.find(textA)!.text === "Ship the", 2000);
    const preview = h.api.find(textA)!;
    expect(
      preview.customData?.voiceInterim,
      "the preview is stamped so a reload sweeps it",
    ).toBe(true);
    expect(
      h.api.find(markerA)!.isDeleted,
      "the region marker stays: the take is not over",
    ).toBe(false);
    expect(h.status().completed, "a preview is not a completed take").toBe(0);
    expect(h.status().pending, "and it is not counted as work in flight").toBe(
      0,
    );

    // The utterance closes: every slice is abandoned and the FINAL cut is what lands.
    await until(() => stt.calls.some((c) => !c.done), 2000); // the next slice is already out
    const slices = stt.calls.filter((c) => !c.done);
    h.capture.clock = OPEN_ONSET + 3000;
    h.capture.onUtteranceEnd?.({
      id: 1,
      onsetMs: OPEN_ONSET + 900,
      endMs: OPEN_ONSET + 2500,
    });
    expect(
      slices.length,
      "at least one slice was still open when the speech stopped",
    ).toBeGreaterThan(0);
    expect(
      slices.every((c) => c.signal?.aborted),
      "the open slices were aborted at the utterance end",
    ).toBe(true);

    const final = stt.calls.at(-1)!;
    final.answer(SENTENCE);
    await until(() => h.status().completed === 1, 3000);
    const committed = h.api.find(textA)!;
    expect(committed.text, "the final transcript replaced the preview").toBe(
      SENTENCE,
    );
    expect(
      committed.customData?.voiceInterim,
      "and the interim stamp is gone",
    ).toBeUndefined();
    expect(
      h.api.find(markerA)!.isDeleted,
      "the marker left with the commit",
    ).toBe(true);
  });

  it("ignores a slice that answers after the final transcript has landed", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 200, interimMs: 40 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const markerA = h.api.elements.find((e) => e.type === "rectangle")!.id;
    const textA = h.api.elements.find((e) => e.containerId === markerA)!.id;

    h.capture.clock = OPEN_ONSET + 1000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: OPEN_ONSET + 900 });
    await until(() => stt.calls.length === 1, 2000);
    const slice = stt.calls[0]!;

    h.capture.clock = OPEN_ONSET + 3000;
    h.capture.onUtteranceEnd?.({
      id: 1,
      onsetMs: OPEN_ONSET + 900,
      endMs: OPEN_ONSET + 2500,
    });
    await until(() => stt.calls.length === 2, 2000);
    stt.calls[1]!.answer(SENTENCE);
    await until(() => h.status().completed === 1, 3000);

    // The slice answers LATE, with the founder's words already on the canvas.
    slice.answer("Ship the voice");
    await wait(40);
    expect(
      h.api.find(textA)!.text,
      "a stale slice may never overwrite the landed words",
    ).toBe(SENTENCE);
    expect(h.api.find(textA)!.customData?.voiceInterim).toBeUndefined();
    expect(h.status().completed).toBe(1);
  });

  it("reverts the provisional region when the final assignment gives the words to a later stroke", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 1500, interimMs: 40 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const markerA = h.api.elements.find((e) => e.type === "rectangle")!.id;
    const textA = h.api.elements.find((e) => e.containerId === markerA)!.id;

    // Speech starts while A is the only region, so the preview goes there.
    h.capture.clock = 3000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 2900 });
    await until(() => stt.calls.length === 1, 2000);
    stt.calls[0]!.answer("Ship the");
    await until(() => h.api.find(textA)!.text === "Ship the", 2000);

    // Then the founder draws the region they actually meant, inside the pre-roll window: assign.ts hands the words
    // to the LATER stroke, and A has to be left exactly as it was found.
    h.capture.clock = 3600;
    await h.stroke("ink-b");
    const markerB = h.api.elements.find(
      (e) => e.type === "rectangle" && e.id !== markerA,
    )!.id;
    const textB = h.api.elements.find((e) => e.containerId === markerB)!.id;

    h.capture.clock = 5000;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 2900, endMs: 4500 });
    await until(() => stt.calls.some((c) => !c.done), 2000);
    stt.calls.at(-1)!.answer(SENTENCE);
    await until(() => h.status().completed === 1, 3000);

    expect(
      h.api.find(textB)!.text,
      "the words went to the region the assignment chose",
    ).toBe(SENTENCE);
    expect(
      h.api.find(textA)!.text,
      "the region the preview borrowed is a placeholder again",
    ).toBe("·");
    expect(
      h.api.find(textA)!.customData?.voiceInterim,
      "with the interim stamp cleared",
    ).toBeUndefined();
    expect(
      h.api.find(markerA)!.isDeleted,
      "and the region itself is still the founder's",
    ).toBe(false);
  });
});

/**
 * The seam round 5 opened, gated. The request now leaves BEFORE the region is chosen, so "the founder deleted the
 * region while the words were in flight" (their deletion is the answer — e2e G5c) and "the region was already gone
 * when we started" (the words survive as an orphan — e2e N2d) are no longer told apart by when the target happened
 * to be resolved. `UtteranceEntry.liveTargets` is what tells them apart, and this is the pair that pins it.
 */
describe("R5 — a region that dies while the transcript is in flight", () => {
  it("drops the result silently: the founder deleted that region on purpose", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 200 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const marker = h.api.elements.find((e) => e.type === "rectangle")!;
    const text = h.api.elements.find((e) => e.containerId === marker.id)!;
    h.capture.clock = 1200;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1200 });
    h.capture.clock = 3000;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1200, endMs: 2500 });
    await until(() => stt.calls.length === 1, 1000);

    // Ctrl+Z (or the eraser) with the words already on their way back.
    h.api.elements = h.api.elements.map((e) =>
      e.id === marker.id || e.id === text.id
        ? ({ ...e, isDeleted: true } as El)
        : e,
    );
    stt.calls[0]!.answer(SENTENCE);
    await wait(60);

    expect(h.status().completed, "nothing was written").toBe(0);
    expect(
      h.status().orphans,
      "and nothing was placed where the box used to be",
    ).toBe(0);
    expect(
      h.api.elements.some((e) => !e.isDeleted && e.text === SENTENCE),
    ).toBe(false);
  });

  it("still orphans an utterance whose region was already gone when the audio was sent", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 200 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const marker = h.api.elements.find((e) => e.type === "rectangle")!;
    const text = h.api.elements.find((e) => e.containerId === marker.id)!;
    // Undone BEFORE a word is spoken: the stroke record is stale, and the words must not be thrown away with it.
    h.api.elements = h.api.elements.map((e) =>
      e.id === marker.id || e.id === text.id
        ? ({ ...e, isDeleted: true } as El)
        : e,
    );

    h.capture.clock = 1200;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1200 });
    h.capture.clock = 3000;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1200, endMs: 2500 });
    await until(() => stt.calls.length === 1, 1000);
    stt.calls[0]!.answer(SENTENCE);

    await until(() => h.status().completed === 1, 2000);
    expect(
      h.status().orphans,
      "placed as free text where the pen last was",
    ).toBe(1);
  });
});

/**
 * Round 5b — the orderings round 5's two new side channels (the interim preview and `liveTargets`) opened, and the
 * latency the pen-down barrier was still costing. Each case here was a live defect on 3a38b19.
 */
describe("R5b — the failure channel after a preview has landed", () => {
  const OPEN_ONSET = 1000;

  it("writes the ⚠ over the preview instead of leaving half a sentence nothing can take back", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 200, interimMs: 40 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const markerA = h.api.elements.find((e) => e.type === "rectangle")!.id;
    const textA = h.api.elements.find((e) => e.containerId === markerA)!.id;

    h.capture.clock = OPEN_ONSET + 1000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: OPEN_ONSET + 900 });
    await until(() => stt.calls.length === 1, 2000);
    stt.calls[0]!.answer("Ship the");
    await until(() => h.api.find(textA)!.text === "Ship the", 2000);
    expect(h.api.find(textA)!.customData?.voiceInterim).toBe(true);

    // The FINAL request fails. Before round 5b fit.markFailed refused to overwrite the preview (it is words), so
    // the region kept "Ship the" at 45 % for ever: the entry is `failed`, so neither a later render, nor the
    // animation tick, nor the disarm sweep ever touches it again — and the next reload swept the words silently.
    h.capture.clock = OPEN_ONSET + 3000;
    h.capture.onUtteranceEnd?.({
      id: 1,
      onsetMs: OPEN_ONSET + 900,
      endMs: OPEN_ONSET + 2500,
    });
    await until(() => stt.calls.some((c) => !c.done), 2000);
    stt.calls.at(-1)!.reject(new Error("STT server unreachable"));
    await until(() => h.status().failed === 1, 3000);

    const region = h.api.find(textA)!;
    expect(
      region.text,
      "the failure is reported in the region the founder spoke into",
    ).toBe("⚠ STT");
    expect(
      region.customData?.voiceInterim,
      "and the preview's stamp is gone",
    ).toBeUndefined();
    expect(
      region.customData?.voiceFailed,
      "stamped so a reload sweeps the warning, not a transcript",
    ).toBe(true);
    expect(region.opacity, "at full opacity: a report, not a guess").toBe(100);
    expect(
      h.api.find(markerA)!.isDeleted,
      "the marker stays dashed so the retry has a visible target",
    ).toBe(false);
  });
});

describe("R5b — a region erased while its own preview was up", () => {
  const OPEN_ONSET = 1000;

  it("drops the words silently even though the preview's re-render pruned the entry", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 200, interimMs: 40 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const markerA = h.api.elements.find((e) => e.type === "rectangle")!;
    const textA = h.api.elements.find((e) => e.containerId === markerA.id)!;

    h.capture.clock = OPEN_ONSET + 1000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: OPEN_ONSET + 900 });
    await until(() => stt.calls.length === 1, 2000);
    stt.calls[0]!.answer("Ship the");
    await until(() => h.api.find(textA.id)!.text === "Ship the", 2000);

    // One Ctrl+Z while the preview is up takes the region away (the preview itself is written with NEVER, so it is
    // not its own undo step). The next slice then re-renders the region, which prunes the entry AND its stroke
    // record — the assignment comes back null and the sentence used to be dumped where the box had just been.
    h.api.elements = h.api.elements.map((e) =>
      e.id === markerA.id || e.id === textA.id
        ? ({ ...e, isDeleted: true } as El)
        : e,
    );
    await until(() => stt.calls.length >= 2, 2000);
    stt.calls[1]!.answer("Ship the voice");
    await wait(40);

    h.capture.clock = OPEN_ONSET + 3000;
    h.capture.onUtteranceEnd?.({
      id: 1,
      onsetMs: OPEN_ONSET + 900,
      endMs: OPEN_ONSET + 2500,
    });
    await until(() => stt.calls.some((c) => !c.done), 2000);
    stt.calls.at(-1)!.answer(SENTENCE);
    await wait(80);

    expect(
      h.status().orphans,
      "nothing was placed where the founder had just erased a box",
    ).toBe(0);
    expect(h.status().completed, "and nothing was written").toBe(0);
    expect(
      h.api.elements.some((e) => !e.isDeleted && e.text === SENTENCE),
    ).toBe(false);
  });

  it("drops a region created AFTER the audio was sent and erased before the answer came back", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 1500 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    // Round 5's headline gesture: the pen is down and the label is spoken and FINISHED before pen-up, so the region
    // that ends up owning the utterance does not exist when `liveTargets` is snapshotted.
    h.capture.clock = 1000;
    h.strokeDown("ink-a");
    h.capture.clock = 1200;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1200 });
    h.capture.clock = 3100;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1200, endMs: 3000 });
    await until(() => stt.calls.length === 1, 2000);

    await h.strokeUp("ink-a");
    const marker = h.api.elements.find((e) => e.type === "rectangle")!;
    const text = h.api.elements.find((e) => e.containerId === marker.id)!;
    // The founder erases the box they just drew, with the words still in flight.
    h.api.elements = h.api.elements.map((e) =>
      e.id === marker.id || e.id === text.id
        ? ({ ...e, isDeleted: true } as El)
        : e,
    );
    stt.calls[0]!.answer(SENTENCE);
    await wait(80);

    expect(
      h.status().orphans,
      "their deletion is the answer, not an orphan at the pen origin",
    ).toBe(0);
    expect(h.status().completed).toBe(0);
    expect(
      h.api.elements.some((e) => !e.isDeleted && e.text === SENTENCE),
    ).toBe(false);
  });
});

describe("R5b — the pen-down barrier is per utterance, not per session", () => {
  it("settles an utterance no open stroke could claim instead of waiting out the next stroke", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 1500 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const markerA = h.api.elements.find((e) => e.type === "rectangle")!.id;
    const textA = h.api.elements.find((e) => e.containerId === markerA)!.id;

    h.capture.clock = 1200;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1200 });

    // The founder starts the NEXT box at 3000 — outside this utterance's window (1200 + 1500), so assign.ts could
    // never give these words to it — and is still drawing it when the sentence ends and the transcript comes back.
    h.capture.clock = 3000;
    h.strokeDown("ink-b");
    h.capture.clock = 3100;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1200, endMs: 3000 });
    await until(() => stt.calls.length === 1, 2000);
    stt.calls[0]!.answer(SENTENCE);

    // No pen-up for ink-b anywhere in this assertion: the words must not wait for a stroke that cannot claim them.
    await until(() => h.status().completed === 1, 2000);
    expect(
      h.api.find(textA)!.text,
      "and they landed in the region that did win them",
    ).toBe(SENTENCE);
    expect(h.status().orphans).toBe(0);

    await h.strokeUp("ink-b");
  });

  it("still waits for a stroke whose pointer-down IS inside the utterance's window (gate N2e)", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 1500 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: 1000 });
    // Pen-down at 1200, inside 1000 + 1500: this stroke is a candidate and the words are its.
    h.capture.clock = 1200;
    h.strokeDown("ink-a");
    h.capture.clock = 2800;
    h.capture.onUtteranceEnd?.({ id: 1, onsetMs: 1000, endMs: 2700 });
    await until(() => stt.calls.length === 1, 2000);
    stt.calls[0]!.answer(SENTENCE);
    await wait(80);
    expect(
      h.status().completed,
      "nothing is written while that stroke is open",
    ).toBe(0);
    expect(h.status().orphans).toBe(0);

    await h.strokeUp("ink-a");
    await until(() => h.status().completed === 1, 2000);
    const marker = h.api.elements.find((e) => e.type === "rectangle")!;
    expect(
      h.api.find(marker.id)!.isDeleted,
      "the words landed in the region being drawn",
    ).toBe(true);
    expect(h.status().orphans).toBe(0);
  });
});

describe("R5b — a preview leaving a region that already has words", () => {
  const OPEN_ONSET = 1000;

  it("re-renders it as cosmetic churn, without a second undo checkpoint the founder did not cause", async () => {
    const stt = scriptedTranscribe();
    const h = harness({ preRollMs: 200, interimMs: 40 }, stt.fn);
    live = h.controller;
    h.controller.toggleLatch();
    await until(() => h.capture.active);

    h.capture.clock = 1000;
    await h.stroke("ink-a");
    const markerA = h.api.elements.find((e) => e.type === "rectangle")!.id;
    const textA = h.api.elements.find((e) => e.containerId === markerA)!.id;

    // Two takes previewing into the SAME region: ordinary on the wall (the VAD closes one while the founder keeps
    // talking), and the reason take 2's preview later has to leave a region take 1 has committed into.
    h.capture.clock = OPEN_ONSET + 1000;
    h.capture.onUtteranceStart?.({ id: 1, onsetMs: OPEN_ONSET + 900 });
    h.capture.onUtteranceStart?.({ id: 2, onsetMs: OPEN_ONSET + 950 });
    await until(() => stt.calls.length >= 2, 2000);
    stt.calls[0]!.answer("Ship the");
    stt.calls[1]!.answer("and the wall");
    await until(
      () => (h.api.find(textA)!.text ?? "").includes("and the wall"),
      2000,
    );
    expect(
      h.api.find(textA)!.customData?.voiceInterim,
      "both previews are in that region",
    ).toBe(true);

    // Take 1 closes and lands its words there.
    const sentAt = stt.calls.length;
    h.capture.clock = OPEN_ONSET + 2000;
    h.capture.onUtteranceEnd?.({
      id: 1,
      onsetMs: OPEN_ONSET + 900,
      endMs: OPEN_ONSET + 1900,
    });
    await until(() => stt.calls.length > sentAt, 2000);
    stt.calls[sentAt]!.answer(SENTENCE);
    await until(() => h.status().completed === 1, 3000);
    const committedWrites = (): number =>
      h.api.writes.filter(
        (w) =>
          w.captureUpdate === "IMMEDIATELY" &&
          w.elements.some((e) => e.id === textA && e.text === SENTENCE),
      ).length;
    expect(
      committedWrites(),
      "the words themselves are the founder's edit, written once",
    ).toBe(1);

    // Take 2's next slice finds the region occupied (`parts.length > 0`), so its preview leaves it — which
    // re-renders words that are already correct. Cosmetic churn is NEVER (the captureUpdate invariant): with
    // IMMEDIATELY the founder gets an undo step that reverts a write nothing can tell apart from the one before it.
    await until(
      () => stt.calls.filter((c) => !c.done && !c.signal?.aborted).length > 0,
      2000,
    );
    const slice = stt.calls
      .filter((c) => !c.done && !c.signal?.aborted)
      .at(-1)!;
    slice.answer("and the wall panel");
    await wait(80);
    expect(h.api.find(textA)!.text, "the landed words are untouched").toBe(
      SENTENCE,
    );
    expect(
      committedWrites(),
      "and no second undo checkpoint was created for them",
    ).toBe(1);
  });
});
