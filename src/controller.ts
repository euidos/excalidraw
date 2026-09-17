/**
 * controller.ts — the voice-area state machine (round 2).
 *
 * DOM-free by design (only timers / requestAnimationFrame / performance and the Excalidraw imperative API):
 * keyboard wiring lives in App.tsx, element construction in fit.ts, audio in capture.ts, attribution in assign.ts.
 *
 * Round-2 model (DESIGN R1–R4): a session is one armed period. Strokes produce targets (a container plus a
 * placeholder text); the capture module produces utterances (speech bursts bounded by silence); assign.ts maps
 * utterances onto strokes, so an utterance may land in a shape drawn slightly AFTER the speaker started talking.
 * Several utterances can share one target — their texts are appended in onset order and the shape is refitted.
 */
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  NATIVE_CONTAINER_TOOLS,
  type CreateVoiceController,
  type FitOptions,
  type Point,
  type StyleSnapshot,
  type VoiceController,
  type VoiceControllerDeps,
  type VoiceMode,
  type VoiceStatus,
  type VoiceTarget,
} from "./contracts";
import {
  isHallucination,
  type MicState,
  type StrokeRecord,
  type UtteranceEvent,
} from "./contracts-capture";

type CaptureAction = (typeof CaptureUpdateAction)[keyof typeof CaptureUpdateAction];
type ActiveTool = AppState["activeTool"];
type SetActiveToolArg = Parameters<ExcalidrawImperativeAPI["setActiveTool"]>[0];

const PLACEHOLDER_INTERVAL_MS = 350;
/** The library finalises the drawn element after onPointerUp fires; wait a tick plus a frame. */
const POINTER_UP_DELAY_MS = 30;
/** Audio kept around each utterance in its WAV, so whisper hears the attack and the tail. */
const WAV_PAD_MS = 250;
const ORPHAN_FONT_SIZE = 24;
const FAILED_TEXT = "⚠ STT";
const FAILED_COLOR = "#c92a2a";
/** Failed segments keep their audio in memory for retry; oldest are dropped past this. */
const MAX_FAILED = 20;
const MAX_ATTEMPTS = 3;
/** Gesture-scale thresholds are SCREEN px (RETRO L4): divided by zoom at the call site. */
const TAP_MIN_SCREEN_PX = 12;
const VERTICAL_LINE_AREA_SCREEN_PX = 80;

const NATIVE_TOOL_SET: ReadonlySet<string> = new Set<string>(NATIVE_CONTAINER_TOOLS);
const isNativeContainerTool = (type: string): boolean => NATIVE_TOOL_SET.has(type);

/**
 * Is `ownDownMs`'s target done receiving speech because a later stroke took over?
 *
 * assign.ts's rule is "a stroke is a candidate for an utterance when downMs ≤ onsetMs + preRoll, latest candidate
 * wins", i.e. `later` can claim an utterance exactly when `later.downMs - preRollMs <= onsetMs`. So a later stroke
 * supersedes `own` only when it outranks it for EVERY utterance still waiting for an owner; if even one open
 * utterance started before that stroke's pre-roll window, that utterance is still `own`'s and `own` must stay open
 * to receive it. Exported for the unit gate — the inverted form of this test silently discarded live targets.
 */
export function isSuperseded(
  ownDownMs: number,
  strokes: readonly StrokeRecord[],
  openOnsets: readonly number[],
  preRollMs: number,
): boolean {
  return strokes.some(
    (later) =>
      later.downMs > ownDownMs && openOnsets.every((onset) => later.downMs - preRollMs <= onset),
  );
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : String(err);

const snapshotStyle = (appState: AppState): StyleSnapshot => ({
  strokeColor: appState.currentItemStrokeColor,
  backgroundColor: appState.currentItemBackgroundColor,
  fillStyle: appState.currentItemFillStyle,
  strokeWidth: appState.currentItemStrokeWidth,
  strokeStyle: appState.currentItemStrokeStyle,
  roughness: appState.currentItemRoughness,
  opacity: appState.currentItemOpacity,
  roundness: appState.currentItemRoundness,
  fontFamily: appState.currentItemFontFamily,
});

/** setActiveTool takes a narrower union than appState.activeTool carries, so rebuild the argument. */
const toolArg = (tool: ActiveTool): SetActiveToolArg => {
  if (tool.type === "custom") {
    return { type: "custom", customType: tool.customType, locked: tool.locked };
  }
  if (tool.type === "image") {
    return { type: "image", locked: tool.locked };
  }
  return { type: tool.type, locked: tool.locked };
};

interface TextPart {
  utteranceId: number;
  onsetMs: number;
  text: string;
}
interface TargetEntry {
  target: VoiceTarget;
  style: StyleSnapshot;
  parts: TextPart[];
  /** No further utterance can land here. */
  closed: boolean;
  /** Showing "⚠ STT": never animated, never discarded, retryable. */
  failed: boolean;
  /** Speech without a stroke: the text element is its own container. */
  orphan: boolean;
}
interface UtteranceEntry {
  id: number;
  onsetMs: number;
  endMs?: number;
  /** undefined while assignment is not final yet; null once it is final and orphaned. */
  assigned?: string | null;
  /** Dispatched and finished (committed, dropped or failed). */
  resolved: boolean;
  /** Free text created for this orphan, so a retry re-uses it instead of stacking another. */
  orphanTextId?: string;
  finalTimer?: ReturnType<typeof setTimeout>;
}
interface Session {
  style: StyleSnapshot;
  ended: boolean;
  strokes: StrokeRecord[];
  targets: Map<string, TargetEntry>;
  utterances: Map<number, UtteranceEntry>;
  /** Stroke conversions apply in the order the strokes were drawn. */
  captureQueue: Promise<void>;
  /** Conversions queued but not yet applied: assignment must wait for their strokes. */
  conversions: number;
  /** Element ids seen at arm and after every conversion (the new element exists before onPointerDown). */
  knownIds: Set<string>;
}
interface CurrentStroke {
  session: Session;
  downMs: number;
  toolType: string;
  candidateId?: string;
  style: StyleSnapshot;
}
interface PendingEntry {
  abort: AbortController;
}
interface FailedEntry {
  utteranceId: number;
  session: Session;
  utterance: UtteranceEntry;
  entry: TargetEntry;
  blob: Blob;
  attempts: number;
}

export const createVoiceController: CreateVoiceController = ({
  api,
  capture,
  assign,
  transcribe,
  fit,
  recognize,
  getSettings,
  onStatus,
}: VoiceControllerDeps): VoiceController => {
  let mode: VoiceMode = "idle";
  let session: Session | null = null;
  /** Sessions that still have something to animate, assign or resolve (the current one included). */
  const sessions = new Set<Session>();
  const pending = new Map<number, PendingEntry>();
  const failed = new Map<number, FailedEntry>();
  const utteranceSession = new Map<number, Session>();

  /** Only set when we switched the tool ourselves, so we only restore what we changed. */
  let previousTool: ActiveTool | null = null;
  let currentStroke: CurrentStroke | null = null;
  let lastPointer: Point | null = null;
  let frame = 0;
  let level = 0;
  let lastError: string | undefined;
  let micDetail: string | undefined;
  let maxPendingSeen = 0;
  let completed = 0;
  let utteranceCount = 0;
  let orphanCount = 0;
  let droppedCount = 0;
  let lastDropped: string | undefined;
  let lastTranscript: string | undefined;
  let disposed = false;
  /** armBody owns the mic outcome while it runs; onMicChange must not disarm underneath it. */
  let arming = false;

  let animTimer: ReturnType<typeof setInterval> | null = null;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  const frames = new Set<number>();
  /** Arm / disarm must not interleave. */
  let chain: Promise<void> = Promise.resolve();

  // --- status -------------------------------------------------------------

  const snapshot = (): VoiceStatus => ({
    mode,
    recording: capture.active,
    pending: pending.size,
    failed: failed.size,
    mic: capture.mic,
    level,
    lastError,
    maxPendingSeen,
    completed,
    utterances: utteranceCount,
    orphans: orphanCount,
    lastTranscript,
    dropped: droppedCount,
    lastDropped,
  });
  const emit = (): void => {
    if (disposed) {
      return;
    }
    try {
      onStatus(snapshot());
    } catch (err) {
      console.warn("[voice] onStatus threw", err);
    }
  };
  const fail = (err: unknown): void => {
    lastError = errorMessage(err);
    emit();
  };
  const toast = (message: string): void => {
    try {
      api.setToast({ message });
    } catch (err) {
      console.warn("[voice] setToast failed", err);
    }
  };

  // --- scene helpers ------------------------------------------------------

  /** Replace elements by id (keeping scene order) and append the ones that are new. */
  const applyElements = (updates: readonly ExcalidrawElement[], captureUpdate: CaptureAction): void => {
    if (updates.length === 0) {
      return;
    }
    const current = api.getSceneElementsIncludingDeleted();
    const byId = new Map(updates.map((el) => [el.id, el]));
    const next: ExcalidrawElement[] = current.map((el) => byId.get(el.id) ?? el);
    const known = new Set(current.map((el) => el.id));
    for (const el of updates) {
      if (!known.has(el.id)) {
        next.push(el);
      }
    }
    api.updateScene({ elements: next, captureUpdate });
  };

  /** Elements are never held across frames: look the pair up by id at the moment it is needed. */
  const findPair = (
    target: VoiceTarget,
  ): { container: ExcalidrawElement; text: ExcalidrawTextElement } | null => {
    const elements = api.getSceneElementsIncludingDeleted();
    let container: ExcalidrawElement | undefined;
    let text: ExcalidrawTextElement | undefined;
    for (const el of elements) {
      if (el.id === target.containerId) {
        container = el;
      }
      if (el.id === target.textId && el.type === "text") {
        text = el;
      }
    }
    if (!container || !text || container.isDeleted || text.isDeleted) {
      return null;
    }
    return { container, text };
  };

  /**
   * A target that has left the scene must also leave `strokes`: assign.ts only sees stroke records, so a record
   * kept for an undone / deleted / discarded shape keeps winning utterances that then have nowhere to land.
   */
  const forgetStroke = (owner: Session, textId: string): void => {
    owner.targets.delete(textId);
    const at = owner.strokes.findIndex((s) => s.id === textId);
    if (at >= 0) {
      owner.strokes.splice(at, 1);
    }
  };

  const fitOptions = (): FitOptions => {
    const settings = getSettings();
    return {
      maxFontSize: settings.maxFontSize,
      lineMaxFontSize: settings.lineMaxFontSize,
      lineMinFontSize: settings.lineMinFontSize,
    };
  };

  const viewportCentre = (): Point => {
    const state = api.getAppState();
    const zoom = state.zoom.value || 1;
    return { x: state.width / 2 / zoom - state.scrollX, y: state.height / 2 / zoom - state.scrollY };
  };

  const refreshKnownIds = (target: Session): void => {
    try {
      target.knownIds = new Set(api.getSceneElements().map((el) => el.id));
    } catch (err) {
      fail(err);
    }
  };

  // --- placeholder animation ---------------------------------------------

  const stopAnimation = (): void => {
    if (animTimer !== null) {
      clearInterval(animTimer);
      animTimer = null;
    }
  };

  const tick = (): void => {
    try {
      const ids = new Set<string>();
      for (const s of sessions) {
        for (const entry of s.targets.values()) {
          // Only targets still waiting for their first transcript animate.
          if (!entry.closed && !entry.failed && entry.parts.length === 0) {
            ids.add(entry.target.textId);
          }
        }
      }
      if (ids.size === 0) {
        stopAnimation();
        return;
      }
      frame += 1;
      const updates: ExcalidrawElement[] = [];
      for (const el of api.getSceneElementsIncludingDeleted()) {
        if (el.type === "text" && !el.isDeleted && ids.has(el.id)) {
          updates.push(fit.setPlaceholderFrame(el, frame));
        }
      }
      applyElements(updates, CaptureUpdateAction.NEVER);
    } catch (err) {
      stopAnimation();
      fail(err);
    }
  };

  const startAnimation = (): void => {
    if (animTimer === null && !disposed) {
      animTimer = setInterval(tick, PLACEHOLDER_INTERVAL_MS);
    }
  };

  // --- timers -------------------------------------------------------------

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timeouts.delete(timer);
        resolve();
      }, ms);
      timeouts.add(timer);
    });

  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      const raf = requestAnimationFrame(() => {
        frames.delete(raf);
        resolve();
      });
      frames.add(raf);
    });

  const clearFinalTimer = (u: UtteranceEntry): void => {
    if (u.finalTimer !== undefined) {
      clearTimeout(u.finalTimer);
      timeouts.delete(u.finalTimer);
      u.finalTimer = undefined;
    }
  };

  // --- committing ---------------------------------------------------------

  /** Orphans have no container to fit into: measure a fresh free text, keep the element's id. */
  const orphanPatch = (
    entry: TargetEntry,
    text: ExcalidrawTextElement,
    transcript: string,
  ): Partial<ExcalidrawTextElement> => {
    try {
      const measured = fit.buildFreeText(
        { x: text.x, y: text.y },
        transcript,
        entry.style,
        ORPHAN_FONT_SIZE,
      );
      return {
        text: measured.text,
        originalText: measured.originalText,
        width: measured.width,
        height: measured.height,
        strokeColor: entry.style.strokeColor,
      };
    } catch (err) {
      console.warn("[voice] free-text measurement failed", err);
      return { text: transcript, originalText: transcript, strokeColor: entry.style.strokeColor };
    }
  };

  /** Re-fit the whole target from its parts: a second utterance replaces, not appends to, the drawn text. */
  const recommit = (owner: Session, entry: TargetEntry): void => {
    const combined = [...entry.parts]
      .sort((a, b) => a.onsetMs - b.onsetMs || a.utteranceId - b.utteranceId)
      .map((part) => part.text)
      .join(" ");
    const found = findPair(entry.target);
    if (!found) {
      // The user deleted the shape while we were transcribing: drop the result silently.
      forgetStroke(owner, entry.target.textId);
      return;
    }
    if (entry.orphan) {
      applyElements(
        [newElementWith(found.text, orphanPatch(entry, found.text, combined))],
        CaptureUpdateAction.IMMEDIATELY,
      );
    } else {
      applyElements(
        fit.commitText(entry.target, found.container, found.text, combined, entry.style, fitOptions()),
        CaptureUpdateAction.IMMEDIATELY,
      );
    }
    entry.failed = false;
    completed += 1;
    lastTranscript = combined;
  };

  const markFailed = (
    owner: Session,
    u: UtteranceEntry,
    entry: TargetEntry,
    blob: Blob,
    attempts: number,
    err: unknown,
  ): void => {
    lastError = errorMessage(err);
    entry.failed = true;
    failed.set(u.id, { utteranceId: u.id, session: owner, utterance: u, entry, blob, attempts });
    while (failed.size > MAX_FAILED) {
      const oldest = failed.keys().next();
      if (oldest.done) {
        break;
      }
      failed.delete(oldest.value);
    }
    const found = findPair(entry.target);
    if (!found) {
      return;
    }
    if (entry.orphan) {
      applyElements(
        [
          newElementWith(found.text, {
            text: FAILED_TEXT,
            originalText: FAILED_TEXT,
            strokeColor: FAILED_COLOR,
          }),
        ],
        CaptureUpdateAction.IMMEDIATELY,
      );
    } else {
      applyElements(
        fit.markFailed(entry.target, found.container, found.text, entry.style),
        CaptureUpdateAction.IMMEDIATELY,
      );
    }
  };

  /** No speech ever landed here: keep the shape the user drew, drop the placeholder. */
  const discardTarget = (entry: TargetEntry): void => {
    const found = findPair(entry.target);
    if (!found) {
      return;
    }
    if (entry.orphan) {
      applyElements([newElementWith(found.text, { isDeleted: true })], CaptureUpdateAction.IMMEDIATELY);
      return;
    }
    applyElements(
      fit.discard(entry.target, found.container, found.text, entry.style),
      CaptureUpdateAction.IMMEDIATELY,
    );
  };

  // --- target lifecycle ---------------------------------------------------

  /**
   * A target is closed once nothing can still be said into it: the session is over, or a later stroke exists
   * that any ongoing speech would be assigned to instead — and every utterance of its own has resolved.
   */
  const resolveTargets = (owner: Session): void => {
    const preRollMs = getSettings().preRollMs;
    const openOnsets: number[] = [];
    for (const u of owner.utterances.values()) {
      if (u.assigned === undefined) {
        openOnsets.push(u.onsetMs);
      }
    }
    for (const entry of [...owner.targets.values()]) {
      if (entry.closed) {
        continue;
      }
      const textId = entry.target.textId;
      const own = owner.strokes.find((s) => s.id === textId);
      const superseded =
        // An orphan has no stroke of its own: it is done as soon as its utterance is.
        entry.orphan ||
        (own !== undefined && isSuperseded(own.downMs, owner.strokes, openOnsets, preRollMs));
      if (!owner.ended && !superseded) {
        continue;
      }
      // Orphan utterances carry assigned === null, so they are matched by the free text they created.
      const mine = [...owner.utterances.values()].filter(
        (u) => u.assigned === textId || u.orphanTextId === textId,
      );
      if (!mine.every((u) => u.resolved)) {
        continue;
      }
      entry.closed = true;
      if (entry.parts.length === 0 && !entry.failed) {
        discardTarget(entry);
        forgetStroke(owner, textId);
      }
    }
    // Drop sessions with nothing left to animate or assign (failed entries keep their own references).
    if (
      owner.ended &&
      owner.conversions === 0 &&
      [...owner.utterances.values()].every((u) => u.resolved) &&
      [...owner.targets.values()].every((entry) => entry.closed)
    ) {
      sessions.delete(owner);
    }
  };

  // --- transcription ------------------------------------------------------

  const sendBlob = (
    owner: Session,
    u: UtteranceEntry,
    entry: TargetEntry,
    blob: Blob,
    attempts: number,
  ): void => {
    const settings = getSettings();
    const abort = new AbortController();
    pending.set(u.id, { abort });
    maxPendingSeen = Math.max(maxPendingSeen, pending.size);
    u.resolved = false;
    startAnimation();
    emit();

    void (async () => {
      try {
        const result = await transcribe(
          blob,
          { baseUrl: settings.sttUrl, language: settings.language, prompt: settings.prompt },
          abort.signal,
        );
        if (disposed) {
          return;
        }
        const text = (result.text ?? "").trim();
        if (text && !isHallucination(text)) {
          entry.parts.push({ utteranceId: u.id, onsetMs: u.onsetMs, text });
          recommit(owner, entry);
        } else {
          // Empty, or a known near-silence hallucination: resolved, but nothing to say here. Counted rather than
          // dropped in silence — a filtered answer and a silent room look identical on the canvas.
          droppedCount += 1;
          lastDropped = text;
        }
      } catch (err) {
        if (disposed || abort.signal.aborted) {
          return;
        }
        try {
          markFailed(owner, u, entry, blob, attempts, err);
        } catch (inner) {
          console.warn("[voice] failure handling failed", inner);
          lastError = errorMessage(inner);
        }
      } finally {
        if (!disposed) {
          pending.delete(u.id);
          u.resolved = true;
          try {
            resolveTargets(owner);
          } catch (err) {
            console.warn("[voice] resolveTargets failed", err);
          }
          emit();
        }
      }
    })();
  };

  /** Speech that no stroke can claim becomes plain text where the pen last was. */
  const orphanTarget = (owner: Session, u: UtteranceEntry): TargetEntry | null => {
    if (u.orphanTextId !== undefined) {
      const existing = owner.targets.get(u.orphanTextId);
      if (existing) {
        return existing;
      }
    }
    const at = lastPointer ?? viewportCentre();
    const style = owner.style;
    const text = fit.buildFreeText(at, "·", style, ORPHAN_FONT_SIZE);
    applyElements([text], CaptureUpdateAction.IMMEDIATELY);
    const entry: TargetEntry = {
      target: {
        containerId: text.id,
        textId: text.id,
        shape: { kind: "rectangle", x: at.x, y: at.y, width: 0, height: 0 },
      },
      style,
      parts: [],
      closed: false,
      failed: false,
      orphan: true,
    };
    owner.targets.set(text.id, entry);
    u.orphanTextId = text.id;
    orphanCount += 1;
    return entry;
  };

  /**
   * The target this utterance can actually be written into.
   *
   * assign.ts only knows stroke records, and a record outlives its shape (undo, delete, a discarded target), so
   * the winner it names may no longer be on the canvas. Each dead winner is pruned and the assignment re-run, so
   * the utterance falls through to the next-best candidate and finally to the orphan path instead of being
   * handed to a shape that recommit() will only drop again.
   */
  const liveTarget = (owner: Session, u: UtteranceEntry, strokeId: string | null): TargetEntry | null => {
    const preRollMs = getSettings().preRollMs;
    let id = strokeId;
    while (id !== null) {
      const candidate = owner.targets.get(id);
      if (candidate && findPair(candidate.target)) {
        u.assigned = id;
        return candidate;
      }
      forgetStroke(owner, id);
      // dispatch only runs on a final assignment, so `final` is settled; only the winner among the survivors moves.
      id = assign(
        { id: u.id, onsetMs: u.onsetMs, endMs: u.endMs ?? u.onsetMs },
        owner.strokes,
        u.onsetMs + preRollMs,
        { preRollMs },
      ).strokeId;
    }
    u.assigned = null;
    return orphanTarget(owner, u);
  };

  const dispatch = (owner: Session, u: UtteranceEntry, strokeId: string | null): void => {
    const settings = getSettings();
    const endMs = u.endMs ?? u.onsetMs;
    if (endMs - u.onsetMs < settings.minSegmentMs) {
      // Whisper hallucinates on near-silence: drop it, but count it as resolved.
      u.resolved = true;
      resolveTargets(owner);
      emit();
      return;
    }
    let entry: TargetEntry | null = null;
    let blob: Blob | null = null;
    try {
      blob = capture.wav(u.onsetMs - WAV_PAD_MS, endMs + WAV_PAD_MS);
      entry = liveTarget(owner, u, strokeId);
    } catch (err) {
      fail(err);
    }
    if (!entry || !blob) {
      // Nowhere to put it (not even a free text), or the ring buffer refused the cut.
      u.resolved = true;
      resolveTargets(owner);
      emit();
      return;
    }
    sendBlob(owner, u, entry, blob, 1);
  };

  // --- assignment ---------------------------------------------------------

  const runAssignment = (owner: Session): void => {
    try {
      // A queued conversion still owes us its stroke; its own runAssignment call re-runs this.
      if (!owner.ended && owner.conversions > 0) {
        return;
      }
      const preRollMs = getSettings().preRollMs;
      const nowMs = owner.ended ? Infinity : capture.now();
      for (const u of [...owner.utterances.values()]) {
        if (u.endMs === undefined || u.assigned !== undefined) {
          continue;
        }
        const result = assign(
          { id: u.id, onsetMs: u.onsetMs, endMs: u.endMs },
          owner.strokes,
          nowMs,
          { preRollMs },
        );
        if (!result.final) {
          continue; // a later stroke could still claim it; the final timer re-runs this
        }
        clearFinalTimer(u);
        u.assigned = result.strokeId;
        dispatch(owner, u, result.strokeId);
      }
    } catch (err) {
      fail(err);
    }
  };

  // --- stroke capture -----------------------------------------------------

  /** Turn the element this pointer interaction produced into a container + animated placeholder. */
  const convertStroke = async (
    owner: Session,
    elementId: string,
    downMs: number,
    upMs: number,
    style: StyleSnapshot,
  ): Promise<void> => {
    try {
      // onPointerUp fires before the library finalises the element.
      await delay(POINTER_UP_DELAY_MS);
      await nextFrame();
      if (disposed) {
        return;
      }
      const element = api.getSceneElementsIncludingDeleted().find((el) => el.id === elementId);
      if (!element || element.isDeleted) {
        return; // undone, deleted, or never finalised (a zero-size click)
      }
      const opts = fitOptions();
      let built: { elements: ExcalidrawElement[]; target: VoiceTarget } | null = null;
      if (element.type === "freedraw") {
        const zoom = api.getAppState().zoom.value || 1;
        const points: Point[] = element.points.map((p) => ({ x: element.x + p[0], y: element.y + p[1] }));
        const shape = recognize(points, {
          minSize: TAP_MIN_SCREEN_PX / zoom,
          verticalLineAreaWidth: VERTICAL_LINE_AREA_SCREEN_PX / zoom,
        });
        if (!shape) {
          // A tap / palm contact: erase the ink, claim nothing.
          applyElements([newElementWith(element, { isDeleted: true })], CaptureUpdateAction.IMMEDIATELY);
          return;
        }
        built = fit.buildPlaceholder(shape, style, opts);
        applyElements(
          [newElementWith(element, { isDeleted: true }), ...built.elements],
          CaptureUpdateAction.IMMEDIATELY,
        );
      } else if (
        element.type === "rectangle" ||
        element.type === "ellipse" ||
        element.type === "diamond" ||
        element.type === "line"
      ) {
        built = fit.buildPlaceholderFor(element, style, opts);
        applyElements(built.elements, CaptureUpdateAction.IMMEDIATELY);
      } else {
        return; // arrow, text, image…: not a voice container
      }
      owner.strokes.push({ id: built.target.textId, downMs, upMs });
      owner.targets.set(built.target.textId, {
        target: built.target,
        style,
        parts: [],
        closed: false,
        failed: false,
        orphan: false,
      });
      startAnimation();
    } catch (err) {
      fail(err);
    } finally {
      refreshKnownIds(owner);
      owner.conversions -= 1;
      runAssignment(owner);
      emit();
    }
  };

  /**
   * The library inserts the new element into the scene BEFORE onPointerDown fires, so the candidate is the
   * freshest element of the tool's own type that the session has not seen yet (RETRO L3: identity comes from
   * the interaction, never from a whole-scene diff at capture time).
   */
  const pickCandidate = (owner: Session, expected: string): string | undefined => {
    try {
      const state = api.getAppState();
      const fresh = state.newElement;
      if (fresh && fresh.type === expected && !fresh.isDeleted) {
        return fresh.id;
      }
      const elements = api.getSceneElements();
      for (let i = elements.length - 1; i >= 0; i -= 1) {
        const el = elements[i];
        if (!el.isDeleted && el.type === expected && !owner.knownIds.has(el.id)) {
          return el.id;
        }
      }
    } catch (err) {
      fail(err);
    }
    return undefined;
  };

  const offPointerDown = api.onPointerDown((tool, pointerDownState) => {
    try {
      lastPointer = { x: pointerDownState.origin.x, y: pointerDownState.origin.y };
      const owner = session;
      if (disposed || mode === "idle" || !owner || owner.ended) {
        return;
      }
      if (tool.type !== "freedraw" && !isNativeContainerTool(tool.type)) {
        return;
      }
      currentStroke = {
        session: owner,
        downMs: capture.now(),
        toolType: tool.type,
        candidateId: pickCandidate(owner, tool.type),
        style: snapshotStyle(api.getAppState()),
      };
    } catch (err) {
      fail(err);
    }
  });

  const offPointerUp = api.onPointerUp(() => {
    try {
      const stroke = currentStroke;
      currentStroke = null;
      if (disposed || !stroke || stroke.session.ended) {
        return;
      }
      // newElement is still set here — the library finalises it after this callback.
      const fresh = api.getAppState().newElement;
      const elementId =
        fresh && fresh.type === stroke.toolType ? fresh.id : (stroke.candidateId ?? fresh?.id);
      if (!elementId) {
        return;
      }
      const upMs = capture.now();
      const owner = stroke.session;
      owner.conversions += 1;
      owner.captureQueue = owner.captureQueue.then(() =>
        convertStroke(owner, elementId, stroke.downMs, upMs, stroke.style),
      );
    } catch (err) {
      fail(err);
    }
  });

  // --- capture subscriptions ----------------------------------------------

  const priorLevel = capture.onLevel;
  capture.onLevel = (rms: number): void => {
    level = rms;
    try {
      priorLevel?.(rms);
    } catch (err) {
      console.warn("[voice] onLevel listener threw", err);
    }
    emit();
  };

  const priorStart = capture.onUtteranceStart;
  capture.onUtteranceStart = (u: UtteranceEvent): void => {
    try {
      priorStart?.(u);
    } catch (err) {
      console.warn("[voice] onUtteranceStart listener threw", err);
    }
    try {
      const owner = session;
      if (disposed || !owner || owner.ended) {
        return;
      }
      owner.utterances.set(u.id, { id: u.id, onsetMs: u.onsetMs, resolved: false });
      utteranceSession.set(u.id, owner);
      utteranceCount += 1;
      emit();
    } catch (err) {
      fail(err);
    }
  };

  const priorEnd = capture.onUtteranceEnd;
  capture.onUtteranceEnd = (u: Required<UtteranceEvent>): void => {
    try {
      priorEnd?.(u);
    } catch (err) {
      console.warn("[voice] onUtteranceEnd listener threw", err);
    }
    try {
      const owner = utteranceSession.get(u.id);
      const entry = owner?.utterances.get(u.id);
      if (disposed || !owner || !entry) {
        return;
      }
      entry.endMs = u.endMs;
      if (entry.assigned === undefined) {
        // Assignment only becomes actionable once no future stroke could still claim this utterance.
        const wait = Math.max(0, entry.onsetMs + getSettings().preRollMs - capture.now());
        clearFinalTimer(entry);
        const timer = setTimeout(() => {
          timeouts.delete(timer);
          entry.finalTimer = undefined;
          if (!disposed) {
            runAssignment(owner);
            emit();
          }
        }, wait);
        timeouts.add(timer);
        entry.finalTimer = timer;
      }
      runAssignment(owner);
      emit();
    } catch (err) {
      fail(err);
    }
  };

  const priorMic = capture.onMicChange;
  capture.onMicChange = (mic: MicState, detail?: string): void => {
    try {
      priorMic?.(mic, detail);
    } catch (err) {
      console.warn("[voice] onMicChange listener threw", err);
    }
    try {
      micDetail = detail;
      if (disposed) {
        return;
      }
      // A track that ends or mutes mid-hold must not leave the tool armed and recording nothing.
      if (mic !== "ok" && mode !== "idle" && !arming) {
        lastError = micError(mic, detail);
        toast(lastError);
        mode = "idle";
        enqueue(disarmBody);
      }
      emit();
    } catch (err) {
      fail(err);
    }
  };

  // --- arming / disarming -------------------------------------------------

  function micError(mic: MicState, detail?: string): string {
    return `microphone: ${mic}${detail ? ` (${detail})` : ""}`;
  }

  function enqueue(op: () => Promise<void>): void {
    chain = chain.then(op).catch((err: unknown) => {
      fail(err);
    });
  }

  const restoreTool = (): void => {
    const tool = previousTool;
    previousTool = null;
    if (!tool) {
      return;
    }
    try {
      api.setActiveTool(toolArg(tool));
    } catch (err) {
      fail(err);
    }
  };

  const armBody = async (): Promise<void> => {
    if (mode === "idle" || disposed || session) {
      return; // disarmed again before the queue reached us, or already armed
    }
    arming = true;
    try {
      const settings = getSettings();
      const appState = api.getAppState();
      const style = snapshotStyle(appState);
      const active = appState.activeTool;
      // A custom tool makes the canvas inert; native container tools draw the container themselves.
      if (active.type !== "freedraw" && !isNativeContainerTool(active.type)) {
        previousTool = active;
        api.setActiveTool({ type: "freedraw" });
      }
      micDetail = undefined;
      try {
        if (capture.mic !== "ok") {
          await capture.prepare(settings.deviceId || undefined);
        }
        if (capture.mic === "ok") {
          await capture.start();
        }
      } catch (err) {
        lastError = errorMessage(err);
      }
      if (disposed) {
        return;
      }
      if (capture.mic !== "ok") {
        // Never arm without a mic: strokes would become placeholders nothing can ever fill.
        mode = "idle";
        restoreTool();
        lastError = micError(capture.mic, micDetail);
        toast(lastError);
        emit();
        return;
      }
      capture.setVad({ threshold: settings.vadThreshold, minUtteranceMs: settings.minSegmentMs });
      utteranceCount = 0;
      orphanCount = 0;
      droppedCount = 0;
      lastDropped = undefined;
      const next: Session = {
        style,
        ended: false,
        strokes: [],
        targets: new Map(),
        utterances: new Map(),
        captureQueue: Promise.resolve(),
        conversions: 0,
        knownIds: new Set(api.getSceneElements().map((el) => el.id)),
      };
      session = next;
      sessions.add(next);
      emit();
    } catch (err) {
      mode = "idle";
      restoreTool();
      fail(err);
    } finally {
      arming = false;
    }
  };

  async function disarmBody(): Promise<void> {
    const owner = session;
    session = null;
    currentStroke = null;
    if (!owner) {
      restoreTool();
      emit();
      return;
    }
    try {
      await capture.stop();
    } catch (err) {
      lastError = errorMessage(err);
    }
    // stop() closes the open utterance; its end event lands synchronously or on the next microtask.
    await Promise.resolve();
    // Flush barrier: conversions queued by a pen-up that raced the disarm must land before the session ends.
    for (let i = 0; i < 4; i += 1) {
      const queued = owner.captureQueue;
      try {
        await queued;
      } catch (err) {
        lastError = errorMessage(err);
      }
      if (owner.captureQueue === queued) {
        break;
      }
    }
    owner.ended = true;
    for (const u of owner.utterances.values()) {
      clearFinalTimer(u);
    }
    runAssignment(owner);
    try {
      resolveTargets(owner);
    } catch (err) {
      lastError = errorMessage(err);
    }
    restoreTool();
    emit();
  }

  emit();

  return {
    pressStart(): void {
      if (disposed || mode !== "idle") {
        return;
      }
      mode = "holding";
      emit();
      enqueue(armBody);
    },
    pressEnd(): void {
      if (disposed || mode !== "holding") {
        return;
      }
      mode = "idle";
      emit();
      enqueue(disarmBody);
    },
    toggleLatch(): void {
      if (disposed || mode === "holding") {
        return;
      }
      if (mode === "latched") {
        mode = "idle";
        emit();
        enqueue(disarmBody);
        return;
      }
      mode = "latched";
      emit();
      enqueue(armBody);
    },
    retryFailed(): void {
      if (disposed || failed.size === 0) {
        return;
      }
      try {
        for (const entry of [...failed.values()]) {
          if (entry.attempts >= MAX_ATTEMPTS) {
            continue; // keep it failed and retryable by hand; three rounds is enough
          }
          failed.delete(entry.utteranceId);
          const found = findPair(entry.entry.target);
          if (!found) {
            continue; // its shape is gone; nothing to retry into
          }
          const restored: ExcalidrawElement[] = [
            newElementWith(found.text, {
              text: "·",
              originalText: "·",
              strokeColor: entry.entry.style.strokeColor,
            }),
          ];
          if (!entry.entry.orphan) {
            restored.push(newElementWith(found.container, { strokeStyle: "dashed" }));
          }
          // Cosmetic re-arming the user did not cause.
          applyElements(restored, CaptureUpdateAction.NEVER);
          entry.entry.failed = false;
          entry.entry.closed = false;
          sessions.add(entry.session);
          sendBlob(entry.session, entry.utterance, entry.entry, entry.blob, entry.attempts + 1);
        }
      } catch (err) {
        fail(err);
      }
      emit();
    },
    getStatus(): VoiceStatus {
      // Live, not the last emitted snapshot: capture.mic resolves asynchronously and emits nothing.
      return snapshot();
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      offPointerDown();
      offPointerUp();
      stopAnimation();
      for (const timer of timeouts) {
        clearTimeout(timer);
      }
      timeouts.clear();
      for (const raf of frames) {
        cancelAnimationFrame(raf);
      }
      frames.clear();
      for (const entry of pending.values()) {
        entry.abort.abort();
      }
      capture.onLevel = priorLevel;
      capture.onUtteranceStart = priorStart;
      capture.onUtteranceEnd = priorEnd;
      capture.onMicChange = priorMic;
      session = null;
      currentStroke = null;
      sessions.clear();
      pending.clear();
      failed.clear();
      utteranceSession.clear();
    },
  };
};

export default createVoiceController;
