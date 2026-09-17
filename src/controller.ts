/**
 * controller.ts — the voice-area state machine.
 *
 * DOM-free by design (only setTimeout / requestAnimationFrame / performance and the Excalidraw imperative API):
 * keyboard wiring lives in App.tsx, element construction in fit.ts, audio in audio.ts.
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

type CaptureAction = (typeof CaptureUpdateAction)[keyof typeof CaptureUpdateAction];
type ActiveTool = AppState["activeTool"];
type SetActiveToolArg = Parameters<ExcalidrawImperativeAPI["setActiveTool"]>[0];

/** One armed stretch of audio: from arm / previous stroke until the next stroke or disarm. */
interface OpenSegment {
  startedAt: number;
  target: VoiceTarget | null;
  style: StyleSnapshot;
}
interface SegmentEntry {
  target: VoiceTarget;
  blob: Blob;
  style: StyleSnapshot;
  attempts: number;
}

const PLACEHOLDER_INTERVAL_MS = 350;
/** The library finalises the freedraw element after onPointerUp fires; wait a tick plus a frame. */
const POINTER_UP_DELAY_MS = 30;
const ORPHAN_FONT_SIZE = 24;
const FAILED_TEXT = "⚠ STT";
const FAILED_COLOR = "#c92a2a";

const NATIVE_TOOL_SET: ReadonlySet<string> = new Set<string>(NATIVE_CONTAINER_TOOLS);

const isNativeContainerTool = (type: string): boolean => NATIVE_TOOL_SET.has(type);

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

export const createVoiceController: CreateVoiceController = ({
  api,
  recorder,
  transcribe,
  fit,
  recognize,
  getSettings,
  onStatus,
}: VoiceControllerDeps): VoiceController => {
  let mode: VoiceMode = "idle";
  let segment: OpenSegment | null = null;
  const pending = new Map<string, SegmentEntry>();
  const failed = new Map<string, SegmentEntry>();
  /** Only set when we switched the tool ourselves, so we only restore what we changed. */
  let previousTool: ActiveTool | null = null;
  let frame = 0;
  let level = 0;
  let lastError: string | undefined;
  let maxPendingSeen = 0;
  let completed = 0;
  let disposed = false;

  let animTimer: ReturnType<typeof setInterval> | null = null;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  const frames = new Set<number>();
  /** Recorder operations must not interleave (start/cut/stop share one MediaRecorder). */
  let chain: Promise<void> = Promise.resolve();

  /**
   * Ids of the scene "before the current stroke". Excalidraw inserts the new freedraw/shape element BEFORE it
   * triggers onPointerDown, so this must be taken when arming (and refreshed after each capture), never at
   * pointer-down — otherwise the diff is always empty and no stroke is ever recognised.
   */
  let beforeIds: Set<string> | null = null;
  /** A stroke began while armed: pointer-up only captures when its pointer-down was ours. */
  let strokeStarted = false;
  let lastPointerScene: Point | null = null;

  // --- status -------------------------------------------------------------

  const snapshot = (): VoiceStatus => ({
    mode,
    recording: recorder.recording,
    pending: pending.size,
    failed: failed.size,
    mic: recorder.mic,
    level,
    lastError,
    maxPendingSeen,
    completed,
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

  // --- scene helpers ------------------------------------------------------

  const snapshotScene = (): void => {
    try {
      beforeIds = new Set(api.getSceneElements().map((el) => el.id));
    } catch (err) {
      fail(err);
    }
  };

  /** Replace elements by id (keeping scene order) and append the ones that are new. */
  const applyElements = (updates: readonly ExcalidrawElement[], capture: CaptureAction): void => {
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
    api.updateScene({ elements: next, captureUpdate: capture });
  };

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

  /** Orphans (speech without a stroke) have no container: the text element plays both roles. */
  const isOrphan = (target: VoiceTarget): boolean => target.containerId === target.textId;

  const fitOptions = (): FitOptions => {
    const settings = getSettings();
    return { maxFontSize: settings.maxFontSize, lineMaxFontSize: settings.lineMaxFontSize };
  };

  const viewportCentre = (): Point => {
    const state = api.getAppState();
    const zoom = state.zoom.value || 1;
    return { x: state.width / 2 / zoom - state.scrollX, y: state.height / 2 / zoom - state.scrollY };
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
      if (segment?.target) {
        ids.add(segment.target.textId);
      }
      for (const textId of pending.keys()) {
        if (!failed.has(textId)) {
          ids.add(textId);
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

  // --- transcription ------------------------------------------------------

  const commit = (target: VoiceTarget, style: StyleSnapshot, raw: string): void => {
    const found = findPair(target);
    if (!found) {
      // The user deleted the shape while we were transcribing: drop the result silently.
      emit();
      return;
    }
    const transcript = raw.trim();
    if (isOrphan(target)) {
      if (transcript) {
        const at: Point = { x: found.text.x, y: found.text.y };
        const text = fit.buildFreeText(at, transcript, style, ORPHAN_FONT_SIZE);
        // A fresh element rather than a text swap, so fit's own measurement sets width/height.
        applyElements([newElementWith(found.text, { isDeleted: true }), text], CaptureUpdateAction.IMMEDIATELY);
      } else {
        applyElements([newElementWith(found.text, { isDeleted: true })], CaptureUpdateAction.IMMEDIATELY);
      }
    } else if (transcript) {
      applyElements(
        fit.commitText(target, found.container, found.text, transcript, style, fitOptions()),
        CaptureUpdateAction.IMMEDIATELY,
      );
    } else {
      applyElements(
        fit.discard(target, found.container, found.text, style),
        CaptureUpdateAction.IMMEDIATELY,
      );
    }
    completed += 1;
    emit();
  };

  const markFailed = (entry: SegmentEntry, err: unknown): void => {
    lastError = errorMessage(err);
    const found = findPair(entry.target);
    if (!found) {
      emit();
      return;
    }
    failed.set(entry.target.textId, entry);
    if (isOrphan(entry.target)) {
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
    emit();
  };

  /** Fire and forget: the caller must never wait for a transcript. */
  const dispatch = (blob: Blob, target: VoiceTarget, style: StyleSnapshot, attempts = 0): void => {
    const entry: SegmentEntry = { target, blob, style, attempts: attempts + 1 };
    pending.set(target.textId, entry);
    maxPendingSeen = Math.max(maxPendingSeen, pending.size);
    startAnimation();
    emit();

    const settings = getSettings();
    transcribe(blob, {
      baseUrl: settings.sttUrl,
      language: settings.language,
      prompt: settings.prompt,
    })
      .then((result) => {
        pending.delete(target.textId);
        commit(target, style, result.text ?? "");
      })
      .catch((err: unknown) => {
        pending.delete(target.textId);
        markFailed(entry, err);
      })
      .catch((err: unknown) => {
        // A throw inside our own handlers must not become an unhandled rejection.
        console.warn("[voice] transcript handling failed", err);
        fail(err);
      });
  };

  /** No audio for a target we already drew a placeholder for: restore the shape, drop the placeholder. */
  const discardTarget = (target: VoiceTarget, style: StyleSnapshot): void => {
    const found = findPair(target);
    if (!found) {
      return;
    }
    if (isOrphan(target)) {
      applyElements([newElementWith(found.text, { isDeleted: true })], CaptureUpdateAction.IMMEDIATELY);
      return;
    }
    applyElements(fit.discard(target, found.container, found.text, style), CaptureUpdateAction.IMMEDIATELY);
  };

  // --- arming / disarming -------------------------------------------------

  const enqueue = (op: () => Promise<void>): void => {
    chain = chain.then(op).catch((err: unknown) => {
      fail(err);
    });
  };

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
    if (mode === "idle" || disposed) {
      return; // disarmed again before the queue reached us
    }
    const appState = api.getAppState();
    const style = snapshotStyle(appState);
    const active = appState.activeTool;
    if (active.type !== "freedraw" && !isNativeContainerTool(active.type)) {
      previousTool = active;
      api.setActiveTool({ type: "freedraw" });
    }
    try {
      await recorder.start();
    } catch (err) {
      // Nothing to transcribe without a mic: disarm rather than leave shapes waiting on audio.
      mode = "idle";
      segment = null;
      restoreTool();
      fail(err);
      return;
    }
    segment = { startedAt: performance.now(), target: null, style };
    startAnimation();
    emit();
  };

  const orphan = (blob: Blob, style: StyleSnapshot): void => {
    const at = lastPointerScene ?? viewportCentre();
    const text = fit.buildFreeText(at, "·", style, ORPHAN_FONT_SIZE);
    applyElements([text], CaptureUpdateAction.IMMEDIATELY);
    dispatch(blob, {
      containerId: text.id,
      textId: text.id,
      shape: { kind: "rectangle", x: at.x, y: at.y, width: 0, height: 0 },
    }, style);
  };

  const disarmBody = async (): Promise<void> => {
    const seg = segment;
    segment = null;
    beforeIds = null;
    strokeStarted = false;
    if (!seg) {
      restoreTool();
      emit();
      return;
    }
    let blob: Blob | null = null;
    try {
      blob = await recorder.stop();
    } catch (err) {
      lastError = errorMessage(err);
    }
    try {
      if (seg.target) {
        if (blob) {
          dispatch(blob, seg.target, seg.style);
        } else {
          discardTarget(seg.target, seg.style);
        }
      } else if (blob) {
        orphan(blob, seg.style);
      }
    } catch (err) {
      lastError = errorMessage(err);
    }
    restoreTool();
    emit();
  };

  // --- stroke capture -----------------------------------------------------

  const cutBody = async (target: VoiceTarget, style: StyleSnapshot): Promise<void> => {
    let blob: Blob | null = null;
    try {
      blob = await recorder.cut();
    } catch (err) {
      lastError = errorMessage(err);
    }
    if (blob) {
      dispatch(blob, target, style);
    } else {
      // Segment too short to transcribe — don't leave its placeholder spinning forever.
      discardTarget(target, style);
      emit();
    }
  };

  /** Turn the freshly drawn element into a container + animated placeholder. */
  const captureStrokeBody = (previous: Set<string>): void => {
    const seg = segment;
    if (!seg || seg.target) {
      return; // no open segment, or a stroke already claimed it
    }
    const fresh = api
      .getSceneElements()
      .filter((el) => !previous.has(el.id) && !el.isDeleted && el.type !== "selection");
    const element = fresh[0];
    if (!element) {
      return;
    }
    if (element.type === "freedraw") {
      const points: Point[] = element.points.map((p) => ({ x: element.x + p[0], y: element.y + p[1] }));
      const shape = recognize(points);
      if (!shape) {
        applyElements([newElementWith(element, { isDeleted: true })], CaptureUpdateAction.IMMEDIATELY);
        return;
      }
      const built = fit.buildPlaceholder(shape, seg.style, fitOptions());
      applyElements(
        [newElementWith(element, { isDeleted: true }), ...built.elements],
        CaptureUpdateAction.IMMEDIATELY,
      );
      seg.target = built.target;
      startAnimation();
      emit();
      return;
    }
    if (
      element.type === "rectangle" ||
      element.type === "ellipse" ||
      element.type === "diamond" ||
      element.type === "line"
    ) {
      const built = fit.buildPlaceholderFor(element, seg.style, fitOptions());
      applyElements(built.elements, CaptureUpdateAction.IMMEDIATELY);
      seg.target = built.target;
      startAnimation();
      emit();
    }
  };

  const captureStroke = (previous: Set<string>): void => {
    try {
      captureStrokeBody(previous);
    } finally {
      // The next stroke must diff against the scene that now holds this stroke's replacement.
      snapshotScene();
    }
  };

  const offPointerDown = api.onPointerDown((tool, pointerDownState) => {
    try {
      lastPointerScene = { x: pointerDownState.origin.x, y: pointerDownState.origin.y };
      if (mode === "idle" || disposed) {
        return;
      }
      if (tool.type !== "freedraw" && !isNativeContainerTool(tool.type)) {
        return;
      }
      strokeStarted = true;
      const seg = segment;
      if (seg?.target) {
        // The next stroke is the "done with that one" signal: cut here, keep drawing.
        const target = seg.target;
        const style = seg.style;
        segment = { startedAt: performance.now(), target: null, style: snapshotStyle(api.getAppState()) };
        enqueue(() => cutBody(target, style));
      }
    } catch (err) {
      fail(err);
    }
  });

  const offPointerUp = api.onPointerUp((tool) => {
    try {
      if (mode === "idle" || disposed) {
        return;
      }
      if (tool.type !== "freedraw" && !isNativeContainerTool(tool.type)) {
        return;
      }
      const previous = beforeIds;
      if (!strokeStarted || !previous) {
        return;
      }
      strokeStarted = false;
      const timer = setTimeout(() => {
        timeouts.delete(timer);
        const raf = requestAnimationFrame(() => {
          frames.delete(raf);
          if (disposed) {
            return;
          }
          try {
            captureStroke(previous);
          } catch (err) {
            fail(err);
          }
        });
        frames.add(raf);
      }, POINTER_UP_DELAY_MS);
      timeouts.add(timer);
    } catch (err) {
      fail(err);
    }
  });

  const priorOnLevel = recorder.onLevel;
  recorder.onLevel = (rms: number) => {
    level = rms;
    priorOnLevel?.(rms);
    emit();
  };

  emit();

  return {
    pressStart(): void {
      if (disposed || mode !== "idle") {
        return;
      }
      mode = "holding";
      snapshotScene();
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
      snapshotScene();
      emit();
      enqueue(armBody);
    },
    retryFailed(): void {
      if (disposed || failed.size === 0) {
        return;
      }
      const entries = [...failed.values()];
      failed.clear();
      const restored: ExcalidrawElement[] = [];
      const live: SegmentEntry[] = [];
      for (const entry of entries) {
        const found = findPair(entry.target);
        if (!found) {
          continue; // its shape is gone; nothing to retry into
        }
        restored.push(fit.setPlaceholderFrame(found.text, frame));
        live.push(entry);
      }
      applyElements(restored, CaptureUpdateAction.NEVER);
      for (const entry of live) {
        dispatch(entry.blob, entry.target, entry.style, entry.attempts);
      }
      emit();
    },
    getStatus(): VoiceStatus {
      // Live, not the last emitted snapshot: recorder.mic resolves asynchronously and emits nothing.
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
      recorder.onLevel = priorOnLevel;
      segment = null;
      pending.clear();
      failed.clear();
    },
  };
};

export default createVoiceController;
