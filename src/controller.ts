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
 *
 * Round-5 model (DESIGN R5a–R5c): a take answers two independent questions, and neither waits for the other.
 * WHAT the words are is asked the moment the VAD closes an utterance — with the pen still down, with conversions
 * still queued, with the pre-roll window still open. WHERE they go is still assign.ts's answer, still only
 * actionable once it is `final` and once the flush barrier has let go. `settle()` is where the two meet: whichever
 * arrives second calls it, it is idempotent, and it is the only place a finished utterance is written to the
 * canvas. While an utterance is still OPEN, `interimMs` slices of it are transcribed and previewed in the region
 * assign.ts would pick RIGHT NOW (provisional, not final) — cosmetic writes that never become parts and that the
 * final transcript, or a change of provisional region, overwrites.
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
/** Long enough to read on the wall panel, short enough to be gone before the next stroke needs the space. */
const DROP_TOAST_MS = 2500;
/** A drop leaves no ⚠ and no retry, so the toast is the only thing that distinguishes it from a silent room. */
const NO_SPEECH_TOAST = "No speech heard for that shape";
const MAX_ATTEMPTS = 3;
/**
 * An utterance has to carry this much audio before an interim slice of it is worth a GPU round trip: below it the
 * server answers a fragment of one syllable (or a hallucination), and the preview would flicker nonsense.
 */
const INTERIM_MIN_AGE_MS = 1000;
/** Gesture-scale thresholds are SCREEN px (RETRO L4): divided by zoom at the call site. */
const TAP_MIN_SCREEN_PX = 12;
const VERTICAL_LINE_AREA_SCREEN_PX = 80;

/**
 * Is this text still scaffolding (an animation frame, an empty string or an earlier warning), i.e. may a failure
 * overwrite it? Words that have landed are the only copy the founder has, so nothing may write over them.
 */
const isScaffoldText = (text: string): boolean => {
  const t = text.trim();
  return t === "" || /^\u00b7{1,3}$/.test(t) || t.startsWith(FAILED_TEXT);
};

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
  /** The text currently shows an interim preview, so the dot animation must leave it alone (round 5). */
  interimShown: boolean;
}
/**
 * WHAT the utterance said, tracked independently of WHERE it goes (round 5). The request leaves at the VAD's
 * utterance end, so this slot is routinely `done` (or `failed`) long before `assigned` is known.
 */
interface SttSlot {
  state: "pending" | "done" | "failed" | "dropped";
  /** The transcript, once it came back. */
  text?: string;
  /**
   * The audio that was sent, kept so a retry can re-send it. Absent only for `dropped` — an utterance below
   * `minSegmentMs`, or a ring-buffer cut that failed, never became a request and has nothing to retry.
   */
  blob?: Blob;
  error?: unknown;
  attempts: number;
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
  /** The FINAL transcription of this utterance: sent at utterance end, regardless of the pen. */
  stt?: SttSlot;
  /** True once `settle()` has acted on (assignment + transcript). A retry clears it: that is a new take. */
  settled: boolean;
  interimTimer?: ReturnType<typeof setTimeout>;
  /** Only one interim request per utterance is ever in flight; a newer slice aborts the older one. */
  interimAbort?: AbortController;
  /** Monotonic per utterance, so a slice that returns out of order is ignored. */
  interimSeq: number;
  /**
   * The regions that were alive when this utterance's audio was sent. It is what tells "the founder deleted the
   * region while the words were in flight" (their deletion is the answer — gate G5c) apart from "the region was
   * already gone when we started" (the words fall through to the orphan path — gate N2d). Before round 5 the
   * difference was implicit in WHEN the target was resolved; now that the request leaves before the assignment
   * exists, the distinction has to be recorded.
   */
  liveTargets?: Set<string>;
  /** The words so far, as the preview currently reads. Never a part, never counted, swept on reload. */
  interimText?: string;
  /** The PROVISIONAL region the preview is drawn in (a `VoiceTarget.textId`); may still change. */
  interimTargetId?: string;
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
  /** Round trip of the last FINAL transcription, so a gate can compare it with pen-up → words on the canvas. */
  let lastSttLatencyMs: number | undefined;
  /**
   * Utterances the VAD has opened and not yet closed. `capture.active` only says the stream is open, which on the
   * wall panel looks the same as a dead microphone; this set is what `status.speaking` reports, so the mic glyph can
   * say "these words are being kept" while they are being spoken. Ids, not a counter: an end event for an id that
   * was never opened (or arrives twice) must not push the count negative.
   */
  const openUtterances = new Set<number>();
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
    // Mode-gated so the field is false by construction while idle, whatever the VAD left behind.
    speaking: mode !== "idle" && openUtterances.size > 0,
    lastError,
    maxPendingSeen,
    completed,
    utterances: utteranceCount,
    orphans: orphanCount,
    lastTranscript,
    dropped: droppedCount,
    lastDropped,
    lastSttLatencyMs,
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
  const toast = (message: string, duration?: number): void => {
    try {
      api.setToast(duration === undefined ? { message } : { message, duration });
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

  /**
   * Elements are never held across frames: look the target up by id at the moment it is needed.
   *
   * The TEXT is the element a target lives or dies by. Its region marker is scaffolding that the first commit
   * deletes, so `marker: null` is a normal state — a second utterance into the same region, or a retry after a ⚠
   * that was already written over a committed text, both arrive with the marker long gone (round 4a).
   */
  const findTarget = (
    target: VoiceTarget,
  ): { marker: ExcalidrawElement | null; text: ExcalidrawTextElement } | null => {
    const elements = api.getSceneElementsIncludingDeleted();
    let marker: ExcalidrawElement | undefined;
    let text: ExcalidrawTextElement | undefined;
    for (const el of elements) {
      if (el.id === target.markerId && !el.isDeleted) {
        marker = el;
      }
      if (el.id === target.textId && el.type === "text") {
        text = el;
      }
    }
    if (!text || text.isDeleted) {
      return null;
    }
    return { marker: marker ?? null, text };
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
          // Only targets still waiting for their first transcript animate — and not the ones already showing the
          // words so far, which the dots would overwrite three times a second (round 5).
          if (!entry.closed && !entry.failed && !entry.interimShown && entry.parts.length === 0) {
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

  const clearInterimTimer = (u: UtteranceEntry): void => {
    if (u.interimTimer !== undefined) {
      clearTimeout(u.interimTimer);
      timeouts.delete(u.interimTimer);
      u.interimTimer = undefined;
    }
  };

  /**
   * No more slices of this utterance: the final cut contains everything they did and supersedes them. Called at
   * utterance end, at settle, at disarm and at dispose — an interim request the client no longer wants is also
   * exactly the request the server skips instead of queueing behind the final one (stt-server, round 5).
   */
  const stopInterim = (u: UtteranceEntry): void => {
    clearInterimTimer(u);
    u.interimAbort?.abort();
    u.interimAbort = undefined;
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

  /** The landed words of a target, in onset order: a second utterance replaces, not appends to, the drawn text. */
  const partsText = (entry: TargetEntry): string =>
    [...entry.parts]
      .sort((a, b) => a.onsetMs - b.onsetMs || a.utteranceId - b.utteranceId)
      .map((part) => part.text)
      .join(" ");

  /** The previews of every utterance whose PROVISIONAL region is this target, in onset order. */
  const interimText = (owner: Session, entry: TargetEntry): string =>
    [...owner.utterances.values()]
      .filter((u) => u.interimText !== undefined && u.interimTargetId === entry.target.textId)
      .sort((a, b) => a.onsetMs - b.onsetMs || a.id - b.id)
      .map((u) => u.interimText ?? "")
      .join(" ")
      .trim();

  /**
   * What a target LOOKS LIKE, derived from the target's own state and nothing else: its landed parts if it has
   * any, else the interim previews currently pointing at it, else the animated placeholder.
   *
   * Written as one function on purpose (round 5). A preview is rendered in the PROVISIONAL region — assign.ts's
   * answer before the pre-roll window elapsed — so the final assignment can move the words to a different region,
   * and the one it left has to look exactly as it did before. With rendering derived from state, "revert region A"
   * is "re-render region A"; with per-transition patches it is a special case for every pair of states, which is
   * how a round-4 predicate ended up deleting regions it was never about.
   *
   * Returns false when the target has left the scene (the founder deleted the shape mid-take).
   */
  const renderEntry = (owner: Session, entry: TargetEntry): boolean => {
    const found = findTarget(entry.target);
    if (!found) {
      // The user deleted the shape while we were transcribing: drop the result silently.
      forgetStroke(owner, entry.target.textId);
      return false;
    }
    const combined = partsText(entry);
    if (combined) {
      entry.interimShown = false;
      if (entry.orphan) {
        applyElements(
          [newElementWith(found.text, orphanPatch(entry, found.text, combined))],
          CaptureUpdateAction.IMMEDIATELY,
        );
        return true;
      }
      const built = fit.commitText(
        entry.target, found.text, combined, entry.style, found.marker, fitOptions(),
      );
      // The WORDS are the founder's edit and must be undoable; the marker's removal is scaffolding the app put
      // there, so it is applied with NEVER. Otherwise one Ctrl+Z after a commit brings the dashed box back as a
      // live, ownerless region (nothing would ever discard it again) — exactly the shape request 1 asked to make
      // disappear. Two updates, same tick, same order: words first, then the scaffolding leaves.
      const scaffolding = built.filter(
        (el) => el.id === entry.target.markerId && el.id !== entry.target.textId,
      );
      const words = built.filter((el) => !scaffolding.includes(el));
      applyElements(words, CaptureUpdateAction.IMMEDIATELY);
      applyElements(scaffolding, CaptureUpdateAction.NEVER);
      return true;
    }
    // A ⚠ is a report the founder has to be able to act on; a preview may not paint over it.
    if (entry.failed) {
      return true;
    }
    const preview = entry.orphan ? "" : interimText(owner, entry);
    if (preview && found.marker) {
      const built = fit.commitInterim(
        entry.target, found.text, preview, entry.style, found.marker, fitOptions(),
      );
      if (built.length > 0) {
        // Cosmetic churn the founder did not cause: NEVER, or every slice would be its own undo step.
        applyElements(built, CaptureUpdateAction.NEVER);
        entry.interimShown = true;
        return true;
      }
    }
    if (entry.interimShown) {
      applyElements(
        fit.resetPlaceholder(entry.target, found.marker, found.text, entry.style, fitOptions()),
        CaptureUpdateAction.NEVER,
      );
      entry.interimShown = false;
      startAnimation();
    }
    return true;
  };

  /** Words landed here: render the target and count the take. */
  const recommit = (owner: Session, entry: TargetEntry): void => {
    if (!renderEntry(owner, entry)) {
      return;
    }
    entry.failed = false;
    completed += 1;
    lastTranscript = partsText(entry);
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
    const found = findTarget(entry.target);
    if (!found) {
      return;
    }
    if (entry.orphan) {
      // Same rule as fit.markFailed: a later failure never overwrites words that already landed (they are the only
      // copy on the canvas). `status.failed` + the retry button are the report in that case.
      if (!isScaffoldText(String(found.text.text ?? ""))) {
        return;
      }
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
        fit.markFailed(entry.target, found.marker, found.text, entry.style),
        CaptureUpdateAction.IMMEDIATELY,
      );
    }
  };

  /**
   * An orphan whose utterance produced nothing: the free text the app created for it goes. Nothing the founder drew
   * is involved and its drop was already toasted with the text that was filtered, so this one is silent.
   */
  const discardOrphan = (entry: TargetEntry): void => {
    const found = findTarget(entry.target);
    if (!found) {
      return;
    }
    applyElements([newElementWith(found.text, { isDeleted: true })], CaptureUpdateAction.IMMEDIATELY);
  };

  /**
   * Regions nothing was ever said into, swept at the END of the session — never mid-session (round 4c).
   *
   * Round 4a made "no words landed here" destructive (the marker goes with the placeholder), and `isSuperseded`
   * closes an earlier region the moment a later stroke takes the open speech away. Together those deleted every box
   * the founder drew before they got round to narrating it, while the tool was latched, with a toast as the only
   * trace. A region the founder drew is THEIRS until the take is over: it stays on the canvas, closed, and the
   * disarm removes the leftovers in ONE undoable update that says how many.
   */
  const discardUnspoken = (owner: Session, entries: readonly TargetEntry[]): void => {
    const updates: ExcalidrawElement[] = [];
    let regions = 0;
    for (const entry of entries) {
      const found = findTarget(entry.target);
      forgetStroke(owner, entry.target.textId);
      if (!found) {
        continue;
      }
      regions += 1;
      updates.push(...fit.discard(entry.target, found.marker, found.text, entry.style));
    }
    if (updates.length === 0) {
      return;
    }
    applyElements(updates, CaptureUpdateAction.IMMEDIATELY);
    // Without a toast a silent room and a mic that heard nothing of what was said look identical, and after round 4a
    // there is nothing left on the canvas to point at either.
    toast(
      regions === 1 ? NO_SPEECH_TOAST : `${regions} regions removed \u2014 nothing was said`,
      DROP_TOAST_MS,
    );
  };

  // --- target lifecycle ---------------------------------------------------

  /**
   * A target is closed once nothing can still be said into it: the session is over, or a later stroke exists
   * that any ongoing speech would be assigned to instead — and every utterance of its own has resolved.
   */
  /**
   * A failed entry whose shape has left the scene can never be retried into: retryFailed() looks the pair up and
   * skips it, so it would sit in `failed` forever, holding its WAV alive and keeping the retry button lit for a
   * shape that no longer exists. Every entry the scene has lost is dropped here instead.
   */
  const pruneFailed = (): void => {
    for (const entry of [...failed.values()]) {
      if (!findTarget(entry.entry.target)) {
        failed.delete(entry.utteranceId);
        forgetStroke(entry.session, entry.entry.target.textId);
      }
    }
  };

  const resolveTargets = (owner: Session): void => {
    pruneFailed();
    const preRollMs = getSettings().preRollMs;
    const openOnsets: number[] = [];
    for (const u of owner.utterances.values()) {
      if (u.assigned === undefined) {
        openOnsets.push(u.onsetMs);
      }
    }
    /** Closed regions with nothing in them, swept together once the session is over. */
    const unspoken: TargetEntry[] = [];
    for (const entry of [...owner.targets.values()]) {
      const textId = entry.target.textId;
      if (!entry.closed) {
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
        if (entry.orphan && entry.parts.length === 0 && !entry.failed) {
          discardOrphan(entry);
          forgetStroke(owner, textId);
          continue;
        }
      }
      // A region the founder drew and never spoke into stays exactly where they drew it until the take is over.
      if (owner.ended && entry.parts.length === 0 && !entry.failed && !entry.orphan) {
        unspoken.push(entry);
      }
    }
    if (unspoken.length > 0) {
      discardUnspoken(owner, unspoken);
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

  /**
   * Ask the server WHAT the utterance said. Sent the moment the VAD closes the utterance — the pen may still be
   * down, the conversion queue may be full and the pre-roll window may still be open, none of which this knows or
   * cares about (round 5). The answer lands on `u.stt` and `settle()` decides what to do with it.
   */
  const sendFinal = (owner: Session, u: UtteranceEntry, blob: Blob, attempts: number): void => {
    const settings = getSettings();
    const abort = new AbortController();
    pending.set(u.id, { abort });
    maxPendingSeen = Math.max(maxPendingSeen, pending.size);
    u.resolved = false;
    u.stt = { state: "pending", blob, attempts };
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
        lastSttLatencyMs = result.latencyMs;
        u.stt = { state: "done", text: (result.text ?? "").trim(), blob, attempts };
      } catch (err) {
        if (disposed) {
          return;
        }
        // Only dispose() aborts a FINAL request. Recording it as dropped rather than pending keeps the utterance
        // from holding its target open for ever if that ever changes.
        u.stt = abort.signal.aborted
          ? { state: "dropped", blob, attempts }
          : { state: "failed", blob, attempts, error: err };
      } finally {
        if (!disposed) {
          pending.delete(u.id);
          try {
            settle(owner, u);
          } catch (err) {
            console.warn("[voice] settling the transcript failed", err);
            lastError = errorMessage(err);
          }
          emit();
        }
      }
    })();
  };

  /** Cut the utterance's own WAV and send it. Nothing here consults the pen, the queue or the assignment. */
  const transcribeUtterance = (owner: Session, u: UtteranceEntry): void => {
    const endMs = u.endMs ?? u.onsetMs;
    if (endMs - u.onsetMs < getSettings().minSegmentMs) {
      // Whisper hallucinates on near-silence: nothing is sent, and there is nothing to retry either.
      u.stt = { state: "dropped", attempts: 0 };
      return;
    }
    let blob: Blob | null = null;
    try {
      blob = capture.wav(u.onsetMs - WAV_PAD_MS, endMs + WAV_PAD_MS);
    } catch (err) {
      fail(err);
    }
    if (!blob) {
      u.stt = { state: "dropped", attempts: 0 };
      return;
    }
    u.liveTargets = new Set(
      [...owner.targets.values()].filter((e) => findTarget(e.target)).map((e) => e.target.textId),
    );
    sendFinal(owner, u, blob, 1);
  };

  // --- interim slices -----------------------------------------------------

  /**
   * The region an OPEN utterance would land in if it ended right now: assign.ts with `nowMs = now`, i.e. an answer
   * that is explicitly NOT final and may still move. Only a live region that nothing has landed in qualifies — a
   * preview may never paint over committed words, a ⚠ warning, a closed region or an orphan's free text.
   */
  const provisionalTarget = (owner: Session, u: UtteranceEntry): TargetEntry | null => {
    const preRollMs = getSettings().preRollMs;
    const { strokeId } = assign(
      { id: u.id, onsetMs: u.onsetMs, endMs: u.endMs ?? capture.now() },
      owner.strokes,
      capture.now(),
      { preRollMs },
    );
    if (strokeId === null) {
      return null;
    }
    const entry = owner.targets.get(strokeId);
    if (!entry || entry.orphan || entry.closed || entry.failed || entry.parts.length > 0) {
      return null;
    }
    const found = findTarget(entry.target);
    // No marker means the region already had a take commit into it; there is nothing to preview inside.
    return found && found.marker ? entry : null;
  };

  /** Show (or move) an utterance's preview, re-rendering both the region it leaves and the region it enters. */
  const showInterim = (owner: Session, u: UtteranceEntry, text: string): void => {
    u.interimText = text;
    const entry = provisionalTarget(owner, u);
    const nextId = entry ? entry.target.textId : undefined;
    const prevId = u.interimTargetId;
    u.interimTargetId = nextId;
    if (prevId !== undefined && prevId !== nextId) {
      const prev = owner.targets.get(prevId);
      if (prev) {
        renderEntry(owner, prev);
      }
    }
    if (entry) {
      renderEntry(owner, entry);
    }
    emit();
  };

  /**
   * The preview is over (the final transcript is about to land, or the utterance produced nothing). `keepTextId` is
   * the region the words are going into: re-rendering it here would flash a placeholder in the same tick.
   */
  const dropInterim = (owner: Session, u: UtteranceEntry, keepTextId?: string): void => {
    const prevId = u.interimTargetId;
    u.interimTargetId = undefined;
    u.interimText = undefined;
    if (prevId !== undefined && prevId !== keepTextId) {
      const prev = owner.targets.get(prevId);
      if (prev) {
        renderEntry(owner, prev);
      }
    }
  };

  const sendInterim = (owner: Session, u: UtteranceEntry): void => {
    if (disposed || u.settled || u.endMs !== undefined) {
      return;
    }
    const settings = getSettings();
    let blob: Blob;
    try {
      // From the onset's pad to NOW, with no trailing pad: the utterance has not ended, so there is no tail yet.
      blob = capture.wav(u.onsetMs - WAV_PAD_MS, capture.now());
    } catch (err) {
      console.warn("[voice] interim cut failed", err);
      scheduleInterim(owner, u);
      return;
    }
    // One slice at a time: the newer cut contains everything the older one did, so the older one is waste — and
    // aborting it is what lets the server skip it instead of making the final request queue behind it.
    u.interimAbort?.abort();
    const abort = new AbortController();
    u.interimAbort = abort;
    u.interimSeq += 1;
    const seq = u.interimSeq;
    void (async () => {
      try {
        const result = await transcribe(
          blob,
          { baseUrl: settings.sttUrl, language: settings.language, prompt: settings.prompt },
          abort.signal,
        );
        // A slice that returns after a newer one, after the utterance ended, or after the take settled is stale:
        // the final transcript is the one that counts and it must never be overwritten by a preview.
        if (disposed || abort.signal.aborted || seq !== u.interimSeq || u.settled || u.endMs !== undefined) {
          return;
        }
        const text = (result.text ?? "").trim();
        if (!text || isHallucination(text)) {
          return;
        }
        showInterim(owner, u, text);
      } catch {
        // A preview is cosmetic: an aborted or failed slice is simply not shown. The FINAL request is the one
        // whose failure is reported, and it has its own path.
      } finally {
        // The cadence is measured from the END of a slice, not from its start (round 5, measured): the round trip
        // over the tailnet is ~1.6 s, longer than the 1200 ms default, so a timer that fired regardless aborted
        // every slice with its own successor and the founder never saw a single preview. One at a time, then.
        scheduleInterim(owner, u);
      }
    })();
  };

  /**
   * The next slice of an open utterance: the first once it carries enough audio to transcribe, then `interimMs`
   * after the previous slice came back. Never two in flight.
   */
  const scheduleInterim = (owner: Session, u: UtteranceEntry): void => {
    const interimMs = getSettings().interimMs;
    if (disposed || interimMs <= 0 || u.settled || u.endMs !== undefined) {
      return;
    }
    clearInterimTimer(u);
    const wait = Math.max(interimMs, INTERIM_MIN_AGE_MS - (capture.now() - u.onsetMs));
    const timer = setTimeout(() => {
      timeouts.delete(timer);
      u.interimTimer = undefined;
      if (disposed) {
        return;
      }
      // sendInterim schedules the next one itself, once this one has been answered or abandoned.
      sendInterim(owner, u);
    }, wait);
    timeouts.add(timer);
    u.interimTimer = timer;
  };

  /**
   * A region has just appeared. An utterance whose preview had nowhere to go — the pen was still down on the very
   * stroke that will own it — can now be shown, and one whose provisional owner changed moves.
   */
  const placeInterims = (owner: Session): void => {
    for (const u of [...owner.utterances.values()]) {
      if (u.interimText === undefined || u.settled) {
        continue;
      }
      showInterim(owner, u, u.interimText);
    }
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
        // An orphan has no region: the text is its own marker, and nothing is ever deleted in its place.
        markerId: text.id,
        textId: text.id,
        shape: { kind: "rectangle", x: at.x, y: at.y, width: 0, height: 0 },
      },
      style,
      parts: [],
      closed: false,
      failed: false,
      orphan: true,
      interimShown: false,
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
      if (candidate && findTarget(candidate.target)) {
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

  /**
   * Where the two halves of a take meet (round 5).
   *
   * An utterance needs two independent facts: WHERE it goes (assign.ts, final only once the pre-roll window has
   * elapsed AND the flush barrier has let go of the pen) and WHAT it says (the STT round trip, started at the VAD's
   * utterance end). Either may arrive first, so both completion paths call this and it is idempotent: the first
   * call finds one half missing and returns, the second does the work. Nothing else writes a finished utterance to
   * the canvas.
   */
  function settle(owner: Session, u: UtteranceEntry): void {
    if (disposed || u.settled) {
      return;
    }
    const stt = u.stt;
    // WHERE is not settled (the window, or the pen), or WHAT is not back yet. Whoever is last calls again.
    if (u.assigned === undefined || !stt || stt.state === "pending") {
      return;
    }
    u.settled = true;
    stopInterim(u);
    const finish = (): void => {
      u.resolved = true;
      try {
        resolveTargets(owner);
      } catch (err) {
        console.warn("[voice] resolveTargets failed", err);
      }
      emit();
    };
    if (stt.state === "dropped") {
      // Below minSegmentMs, or a cut the ring buffer refused: nothing was ever sent, nothing to report.
      dropInterim(owner, u);
      finish();
      return;
    }
    const assigned = u.assigned;
    if (assigned !== null && u.liveTargets?.has(assigned)) {
      const owned = owner.targets.get(assigned);
      if (owned && !findTarget(owned.target)) {
        // The founder deleted the region this take was already in while the words were in flight. Their deletion is
        // the answer (gate G5c): an orphan would drop text exactly where they had just removed a box. A region that
        // was ALREADY gone when the audio was sent is a different case and still falls through to the orphan path.
        forgetStroke(owner, assigned);
        dropInterim(owner, u);
        finish();
        return;
      }
    }
    let entry: TargetEntry | null = null;
    try {
      entry = liveTarget(owner, u, assigned);
    } catch (err) {
      fail(err);
    }
    if (!entry) {
      // Nowhere to put it, not even a free text.
      dropInterim(owner, u);
      finish();
      return;
    }
    // The preview stops being the truth here; the region it was drawn in may not be the one the words go to.
    dropInterim(owner, u, entry.target.textId);
    try {
      if (stt.state === "done") {
        const text = (stt.text ?? "").trim();
        if (text && !isHallucination(text)) {
          entry.parts.push({ utteranceId: u.id, onsetMs: u.onsetMs, text });
          recommit(owner, entry);
        } else {
          // Empty, or a known near-silence hallucination: resolved, but nothing to say here. Counted rather than
          // dropped in silence — a filtered answer and a silent room look identical on the canvas.
          droppedCount += 1;
          lastDropped = text;
          // A filter that ate real speech has to be visible the moment it happens (RETRO L2 / gate N10). An empty
          // answer says nothing about *which* shape yet, so that one is toasted by the discard at disarm instead.
          if (text) {
            toast(`Filtered: "${text}"`, DROP_TOAST_MS);
          }
          // Whatever the preview had put in the region goes with it: the region is back to waiting.
          renderEntry(owner, entry);
        }
      } else {
        markFailed(owner, u, entry, stt.blob ?? new Blob([]), stt.attempts, stt.error);
      }
    } catch (err) {
      console.warn("[voice] failure handling failed", err);
      lastError = errorMessage(err);
    }
    finish();
  }

  // --- assignment ---------------------------------------------------------

  const runAssignment = (owner: Session): void => {
    try {
      // A queued conversion still owes us its stroke; its own runAssignment call re-runs this.
      //
      // So does a pen that is still DOWN (gate N2e): a stroke only enters `owner.strokes` inside convertStroke,
      // which the pointer-UP queues, so finalising an assignment while the founder is still drawing measures it
      // against a stroke list that is missing the very region being drawn — the words orphaned somewhere else and
      // (since round 4a) the box was deleted with a "nothing was heard" toast. The flush barrier therefore covers
      // the consumer as well: onPointerUp increments `conversions` and convertStroke's `finally` re-runs this, and
      // a disarm clears `currentStroke` before it sets `ended`, so nothing can wait for a pen that is gone.
      if (!owner.ended && (owner.conversions > 0 || currentStroke?.session === owner)) {
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
        // WHERE is now known. WHAT may have been back for a second already, or may still be in flight.
        settle(owner, u);
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
        interimShown: false,
      });
      startAnimation();
    } catch (err) {
      fail(err);
    } finally {
      refreshKnownIds(owner);
      owner.conversions -= 1;
      runAssignment(owner);
      // The region the founder was drawing exists now: a preview that had nowhere to go can be shown in it.
      try {
        placeInterims(owner);
      } catch (err) {
        console.warn("[voice] placing interim previews failed", err);
      }
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
      const entry: UtteranceEntry = {
        id: u.id,
        onsetMs: u.onsetMs,
        resolved: false,
        settled: false,
        interimSeq: 0,
      };
      owner.utterances.set(u.id, entry);
      utteranceSession.set(u.id, owner);
      utteranceCount += 1;
      openUtterances.add(u.id);
      // The words start appearing while the founder is still talking: slices of the OPEN utterance, previewed in
      // the region assign.ts would pick right now.
      scheduleInterim(owner, entry);
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
      // Cleared before the early return: a closed utterance is no longer speech even if its session has gone.
      openUtterances.delete(u.id);
      const owner = utteranceSession.get(u.id);
      const entry = owner?.utterances.get(u.id);
      if (disposed || !owner || !entry) {
        return;
      }
      entry.endMs = u.endMs;
      // WHAT the words are, asked NOW. Before round 5 this waited for the assignment to be final, which waits for
      // the pen and for the pre-roll window — so the founder paid the whole STT round trip after lifting the pen.
      stopInterim(entry);
      transcribeUtterance(owner, entry);
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
      // Text metrics ARE font metrics: a transcript fitted before the webfont arrived is fitted against fallback
      // metrics and comes out a size or two off — and since round 4a there is no box left around it to hide that.
      // Arming is the last moment that can afford to wait, and it already waits for the microphone.
      try {
        await fit.warmFonts(style.fontFamily);
      } catch (err) {
        console.warn("[voice] font warm-up failed", err);
      }
      if (disposed) {
        return;
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
    // The mic is going away, so nothing can still be "being spoken" — stop() fires the end events for open
    // utterances, but a stream that died mid-utterance never will.
    openUtterances.clear();
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
      // The take is over: no more previews, and the ones in flight are abandoned rather than raced against the
      // final transcripts the disarm is about to settle.
      stopInterim(u);
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
        // Entries whose shape has gone go first, so a retry never counts (or keeps) a target that cannot receive it.
        pruneFailed();
        for (const entry of [...failed.values()]) {
          if (entry.attempts >= MAX_ATTEMPTS) {
            continue; // keep it failed and retryable by hand; three rounds is enough
          }
          failed.delete(entry.utteranceId);
          const found = findTarget(entry.entry.target);
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
          if (!entry.entry.orphan && found.marker) {
            restored.push(newElementWith(found.marker, { strokeStyle: "dashed" }));
          }
          // Cosmetic re-arming the user did not cause.
          applyElements(restored, CaptureUpdateAction.NEVER);
          entry.entry.failed = false;
          entry.entry.closed = false;
          entry.entry.interimShown = false;
          sessions.add(entry.session);
          // A retry is a NEW take for this utterance: settle() must be allowed to act on it again.
          entry.utterance.settled = false;
          sendFinal(entry.session, entry.utterance, entry.blob, entry.attempts + 1);
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
      // Interim slices live outside `pending` (they are cosmetic and must not show up as work in flight).
      for (const owner of sessions) {
        for (const u of owner.utterances.values()) {
          u.interimAbort?.abort();
        }
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
