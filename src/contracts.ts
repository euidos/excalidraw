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
 * audio.ts — one MediaRecorder per segment on a long-lived MediaStream.
 * prepare() acquires the stream once (getUserMedia) and keeps it so start() is instant; start() begins a segment;
 * cut() ends the current segment and immediately starts the next, resolving with the finished blob; stop() ends the
 * last segment (mic stays acquired). Blobs shorter than minDurationMs resolve null.
 */
export type MicState = "unknown" | "ok" | "denied" | "missing" | "error";
export interface SegmentRecorder {
  prepare(deviceId?: string): Promise<MicState>;
  start(): Promise<void>;
  cut(): Promise<Blob | null>;
  stop(): Promise<Blob | null>;
  readonly recording: boolean;
  readonly mic: MicState;
  /** Called ~10×/s with an RMS level 0..1 while recording (for the toolbar indicator). Optional. */
  onLevel?: (rms: number) => void;
  dispose(): void;
}
export interface RecorderOptions {
  mimeType?: string; // default "audio/webm;codecs=opus" when supported
  minDurationMs?: number; // default 300
}
export type CreateSegmentRecorder = (opts?: RecorderOptions) => SegmentRecorder;

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
  minSegmentMs: number;
}
export const DEFAULT_SETTINGS: VoiceSettings = {
  sttUrl: "http://100.81.33.83:8770",
  language: "",
  prompt: "",
  deviceId: "",
  maxFontSize: 96,
  lineMaxFontSize: 36,
  minSegmentMs: 300,
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
}
export interface VoiceControllerDeps {
  api: ExcalidrawImperativeAPI;
  recorder: SegmentRecorder;
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
  status(): VoiceStatus;
  settings(): VoiceSettings;
  setSettings(patch: Partial<VoiceSettings>): void;
}
declare global {
  interface Window { __excalidrawVoice?: VoiceDebug; EXCALIDRAW_ASSET_PATH?: string }
}
