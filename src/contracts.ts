/**
 * Shared contracts for excalidraw-voice. Every module implements exactly the surface declared here;
 * App.tsx wires them. Coordinates are Excalidraw SCENE coordinates unless stated otherwise.
 */
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  FontFamilyValues,
} from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AssignUtterance, VoiceCapture } from "./contracts-capture";

export type Point = { x: number; y: number };

/** What a stroke was recognised as. Areas keep the stroke's bounding box; lines keep their endpoints. */
export type StrokeShape =
  | { kind: "line"; start: Point; end: Point; length: number }
  | { kind: "rectangle" | "ellipse"; x: number; y: number; width: number; height: number };

export interface RecognizeOptions {
  /** Strokes whose bounding-box diagonal is below this (scene px) are taps → null. Default 12. */
  minSize?: number;
  /** Max perpendicular deviation from the chord, as a fraction of chord length, to count as a line. Default 0.12. */
  lineDeviation?: number;
  /** Polygon-area / bbox-area at or above which an area is a rectangle (else ellipse). Default 0.87. */
  rectFill?: number;
  /** Lines steeper than this (degrees from horizontal) become an area instead. Default 60. */
  maxLineAngleDeg?: number;
  /** Minimum width given to an area made from a near-vertical line. Default 80. */
  verticalLineAreaWidth?: number;
}
/** stroke.ts — pure geometry, unit-tested. Returns null for taps / degenerate input. */
export type RecognizeStroke = (points: readonly Point[], opts?: RecognizeOptions) => StrokeShape | null;

/** The user's current item style, snapshotted from appState when a stroke is captured. */
export interface StyleSnapshot {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: AppState["currentItemFillStyle"];
  strokeWidth: number;
  strokeStyle: AppState["currentItemStrokeStyle"];
  roughness: number;
  opacity: number;
  roundness: AppState["currentItemRoundness"];
  fontFamily: FontFamilyValues;
}
export interface FitOptions {
  /** Upper bound for area text. Default 96. */
  maxFontSize?: number;
  /** Lower bound; below this the text is committed at this size even if it overflows. Default 10. */
  minFontSize?: number;
  /** Upper bound for text placed along a line. Default 36. */
  lineMaxFontSize?: number;
  /** Floor for text placed along a line; below this the text wraps to the line's length and grows upward. Default 14. */
  lineMinFontSize?: number;
}
/** Ids the controller needs to find its elements again later (never hold element objects across frames). */
export interface VoiceTarget {
  /** The container (rectangle/ellipse/diamond) or the line element. */
  containerId: string;
  /** The placeholder / final text element. */
  textId: string;
  shape: StrokeShape;
}
export type PlaceholderResult = { elements: ExcalidrawElement[]; target: VoiceTarget };

/**
 * fit.ts — element construction and text fitting. Runs in the browser (uses the library's text measurement).
 *
 * buildPlaceholder: creates the container for `shape` in the user's style (strokeStyle forced to "dashed" while
 * pending) plus a bound placeholder text ("·"). For lines: a `line` element from start→end and a free text element
 * (not bound) positioned along the line. Text ids/element ids come from the library's own id generator.
 *
 * buildPlaceholderFor: same, but for an EXISTING container/line the user drew with a native tool — returns only the
 * new text element plus the container updated with boundElements/dashed stroke.
 *
 * setPlaceholderFrame: returns the text element with its `text` replaced by the next animation frame ("·","··","···").
 *
 * commitText: final transcript. For containers: largest fontSize in [min, max] for which the library's bound-text
 * layout leaves container width/height unchanged (binary search using convertToExcalidrawElements /
 * redrawTextBoundingBox behaviour); returns [container (strokeStyle restored), text]. For lines: single-line text at
 * the largest fontSize ≤ lineMaxFontSize whose width ≤ line length (wrapping to width = length if even minFontSize
 * is too wide), centred on the line midpoint, rotated by the line angle (never upside down), sitting on the line's
 * upper side; returns [line (strokeStyle restored), text].
 *
 * markFailed: text becomes "⚠ STT" in red (#c92a2a) at a small size; container stroke restored.
 * discard: returns the container with the placeholder unbound + strokeStyle restored, and the text marked deleted.
 */
export interface FitModule {
  buildPlaceholder(shape: StrokeShape, style: StyleSnapshot, opts?: FitOptions): PlaceholderResult;
  buildPlaceholderFor(container: ExcalidrawElement, style: StyleSnapshot, opts?: FitOptions): PlaceholderResult;
  setPlaceholderFrame(text: ExcalidrawTextElement, frame: number): ExcalidrawTextElement;
  commitText(
    target: VoiceTarget,
    container: ExcalidrawElement,
    text: ExcalidrawTextElement,
    transcript: string,
    style: StyleSnapshot,
    opts?: FitOptions,
  ): ExcalidrawElement[];
  markFailed(target: VoiceTarget, container: ExcalidrawElement, text: ExcalidrawTextElement, style: StyleSnapshot): ExcalidrawElement[];
  discard(target: VoiceTarget, container: ExcalidrawElement, text: ExcalidrawTextElement, style: StyleSnapshot): ExcalidrawElement[];
  /** Plain text at a point (no container): used when speech arrives without a stroke. */
  buildFreeText(at: Point, transcript: string, style: StyleSnapshot, fontSize: number): ExcalidrawTextElement;
}

/**
 * Microphone state. Audio capture itself is `VoiceCapture` in contracts-capture.ts (implemented by capture.ts);
 * the round-1 MediaRecorder segmenter that used to live here was retired with src/audio.ts.
 */
export type MicState = "unknown" | "ok" | "denied" | "missing" | "error";

/** stt.ts — client for the OpenAI-compatible endpoint. */
export interface SttOptions {
  baseUrl: string; // e.g. http://100.81.33.83:8770
  language?: string; // "" | undefined = auto-detect
  prompt?: string;
  timeoutMs?: number; // default 20000
}
export interface SttResult { text: string; language?: string; durationS?: number; latencyMs: number }
export type SttErrorKind = "offline" | "timeout" | "http" | "loading" | "aborted";
export class SttError extends Error {
  constructor(public kind: SttErrorKind, message: string, public status?: number) { super(message); }
}
export type Transcribe = (blob: Blob, opts: SttOptions, signal?: AbortSignal) => Promise<SttResult>;
export type CheckHealth = (baseUrl: string) => Promise<{ ok: boolean; warm: boolean; model?: string }>;

/** settings.ts — persisted in localStorage under "voice-settings". */
export interface VoiceSettings {
  sttUrl: string;
  language: string; // "" = auto
  prompt: string;
  deviceId: string; // "" = default mic
  maxFontSize: number;
  lineMaxFontSize: number;
  lineMinFontSize: number;
  /** Utterances shorter than this are dropped (whisper hallucinates on near-silence). */
  minSegmentMs: number;
  /** Speech may start this long before its stroke's pointer-down and still belong to it. */
  preRollMs: number;
  /** Energy VAD floor (RMS 0..1); the effective threshold is max(this, 3 × measured noise floor). */
  vadThreshold: number;
  /** Acquire the microphone at page load so the first arm is instant. The e2e turns this off to time fixtures. */
  warmMicOnBoot: boolean;
}
export const DEFAULT_SETTINGS: VoiceSettings = {
  sttUrl: "http://100.81.33.83:8770",
  language: "",
  prompt: "",
  deviceId: "",
  maxFontSize: 96,
  lineMaxFontSize: 36,
  lineMinFontSize: 14,
  minSegmentMs: 400,
  preRollMs: 1500,
  vadThreshold: 0.012,
  warmMicOnBoot: true,
};

/** controller.ts — the state machine. See DESIGN.local.md "Segment cutting" and this JSDoc. */
export type VoiceMode = "idle" | "latched" | "holding";
export interface VoiceStatus {
  mode: VoiceMode;
  recording: boolean;
  pending: number;
  failed: number;
  mic: MicState;
  level: number; // last RMS 0..1
  lastError?: string;
  /** Diagnostics for tests: highest number of simultaneously pending segments observed. */
  maxPendingSeen: number;
  completed: number;
  /** Diagnostics: utterances detected since arm, orphans placed, last transcript committed. */
  utterances: number;
  orphans: number;
  lastTranscript?: string;
  /**
   * Transcripts that came back and were thrown away (empty, or a known near-silence hallucination). Without this
   * the founder cannot tell "the room was silent" from "whisper answered and we filtered it": both leave the
   * shape bare with no ⚠ and no retry.
   */
  dropped: number;
  /** The text of the last drop, so the filter can be audited from the debug surface. */
  lastDropped?: string;
}
export interface VoiceControllerDeps {
  api: ExcalidrawImperativeAPI;
  capture: VoiceCapture;
  assign: AssignUtterance;
  transcribe: Transcribe;
  fit: FitModule;
  recognize: RecognizeStroke;
  getSettings: () => VoiceSettings;
  onStatus: (status: VoiceStatus) => void;
}
export interface VoiceController {
  /** F9 keydown (repeats already filtered). No-op while latched. */
  pressStart(): void;
  /** F9 keyup / window blur. No-op while latched. */
  pressEnd(): void;
  /** Toolbar button tap: latched ⇄ idle. Ignored while holding. */
  toggleLatch(): void;
  /** Re-send every failed segment (audio kept in memory). */
  retryFailed(): void;
  getStatus(): VoiceStatus;
  dispose(): void;
}
export type CreateVoiceController = (deps: VoiceControllerDeps) => VoiceController;

/** Tools whose freshly drawn element is used as the container directly (modifier behaviour). */
export const NATIVE_CONTAINER_TOOLS = ["rectangle", "ellipse", "diamond", "line"] as const;

/** toolbar.tsx — DOM injection next to the native shape buttons. */
export interface ToolbarHandle { update(status: VoiceStatus): void; unmount(): void }
export interface ToolbarOptions {
  onToggle: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}
export type MountVoiceToolbarButton = (excalidrawRoot: HTMLElement, opts: ToolbarOptions) => ToolbarHandle;

/** Debug surface exposed on window for the Playwright e2e (never used by app code). */
export interface VoiceDebug {
  api: ExcalidrawImperativeAPI;
  controller: VoiceController;
  /** The live capture module, so the e2e can read mic state / cut its own WAV without touching app code. */
  capture?: VoiceCapture;
  fit: FitModule;
  recognize: RecognizeStroke;
  status(): VoiceStatus;
  settings(): VoiceSettings;
  setSettings(patch: Partial<VoiceSettings>): void;
}
declare global {
  interface Window { __excalidrawVoice?: VoiceDebug; EXCALIDRAW_ASSET_PATH?: string }
}
