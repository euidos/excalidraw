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
/**
 * The stamp every REGION MARKER carries. A marker is scaffolding — the dashed outline that says "the words go
 * here" — and it is deleted the moment the text lands, so a marker found in a stored scene is always a leftover.
 * `customData` survives localStorage, which is why the mark lives there and not in a module-level set of ids.
 */
export const VOICE_REGION_CUSTOM_DATA: { voiceRegion: true } = { voiceRegion: true };
/** True for elements built as a region marker. Cheap enough to call per element in a sweep. */
export const isRegionMarker = (
  el: { customData?: Record<string, unknown> } | null | undefined,
): boolean => el?.customData?.voiceRegion === true;

/**
 * The stamp a "⚠ STT" warning text carries while a take is failed. Litter is decided by this stamp, never by
 * reading the text content (round 4c): a failed line region and a failed retry into a region whose marker an
 * earlier commit removed both leave an UNBOUND warning, which the sweep could otherwise not tell apart from a
 * founder-typed "⚠ STT …". A commit clears the stamp in the same update that writes the words, so a reload never
 * sweeps a landed transcript.
 */
export const VOICE_FAILED_CUSTOM_DATA: { voiceFailed: true } = { voiceFailed: true };
/** True for the "⚠ STT" text of a take that failed and was never recovered. */
export const isFailedWarning = (
  el: { customData?: Record<string, unknown> } | null | undefined,
): boolean => el?.customData?.voiceFailed === true;

/**
 * The stamp an INTERIM transcript carries while the founder is still speaking (round 5). An interim text is a
 * cosmetic preview: it is written with `CaptureUpdateAction.NEVER`, it is never a `part`, and the commit (or a
 * change of provisional region) overwrites it. It therefore must never survive a reload — `persist.ts` sweeps it
 * by this stamp, exactly like a failure warning, because the words in it look like a real transcript.
 */
export const VOICE_INTERIM_CUSTOM_DATA: { voiceInterim: true } = { voiceInterim: true };
/** True for a text element currently showing an in-flight (interim) transcript. */
export const isInterimText = (
  el: { customData?: Record<string, unknown> } | null | undefined,
): boolean => el?.customData?.voiceInterim === true;

/** Ids the controller needs to find its elements again later (never hold element objects across frames). */
export interface VoiceTarget {
  /**
   * The region marker: the dashed rectangle built for an area stroke, the dashed line for a line stroke, or the
   * shape a native tool drew. It is deleted at commit, so looking this id up may legitimately find nothing —
   * every caller must treat an absent marker as normal, not as an error.
   */
  markerId: string;
  /** The placeholder / final text element. The one element of a target that outlives the take. */
  textId: string;
  /** The region itself, in scene coordinates: the ONLY geometry a commit may fit into once the marker is gone. */
  shape: StrokeShape;
}
export type PlaceholderResult = { elements: ExcalidrawElement[]; target: VoiceTarget };

/**
 * fit.ts — element construction and text fitting. Runs in the browser (uses the library's text measurement).
 *
 * A drawn shape selects a REGION; it is not a drawing. So everything below builds a marker plus a text, and a
 * committed take leaves the text alone on the canvas.
 *
 * buildPlaceholder: for an area (rectangle OR ellipse recognition) a dashed RECTANGLE marker equal to the
 * stroke's bounding box (roundness null, transparent background, strokeWidth 1, the user's strokeColor, reduced
 * opacity) plus a bound placeholder text ("·") centred in it; for a line a dashed `line` element start→end plus a
 * free text ("·") along it. Markers carry `customData` = VOICE_REGION_CUSTOM_DATA. Ids come from the library.
 *
 * buildPlaceholderFor: same, but for an EXISTING element a native tool drew — returns the new placeholder text
 * plus that element turned into a marker (dashed, stamped, bound to the text).
 *
 * setPlaceholderFrame: returns the text element with its `text` replaced by the next animation frame ("·","··","···").
 *
 * commitText: final transcript, fitted to `target.shape` — never to a live marker, which may already be gone.
 * For an area: the largest fontSize in [min, max] whose wrapped layout the library leaves the region's own size
 * unchanged (binary search over convertToExcalidrawElements → redrawTextBoundingBox), committed as a FREE text
 * element (containerId null, autoResize false at the fitted width, so the wrapped lines stay where they were
 * measured). For a line: single-line text at the largest fontSize ≤ lineMaxFontSize whose width ≤ line length
 * (wrapping to width = length if even lineMinFontSize is too wide), centred on the midpoint, rotated by the line
 * angle (never upside down), on the line's upper side. Returns [text] — plus the marker marked deleted when one
 * was passed in, in the SAME update, so nothing but the text is ever visible after a commit.
 *
 * commitInterim: the SAME fit as commitText, but for a transcript that is still being spoken — the region marker
 * STAYS (the take is not over), the text keeps its binding to it, it is drawn at `INTERIM_OPACITY` and it is
 * stamped `customData.voiceInterim` so a reload can sweep it. Returns [] for an empty transcript (nothing to
 * preview) instead of discarding the region.
 *
 * resetPlaceholder: the inverse — puts the animated placeholder's own layout back on the text, clearing the
 * interim stamp. Needed because an interim preview may be rendered in the WRONG region (the provisional
 * assignment) and the final assignment then has to leave that region exactly as it found it.
 *
 * markFailed: text becomes "⚠ STT" in red (#c92a2a) at a small size, inside the region, stamped with
 * VOICE_FAILED_CUSTOM_DATA so a reload can sweep it; the marker (if any) stays dashed so the retry has a visible
 * target. A successful retry goes through commitText, which clears the stamp and removes the marker. A take that
 * fails into a region whose text already carries LANDED WORDS returns [] instead: a later failure may never
 * destroy a transcript that is already on the canvas (the toast and the retry button report it instead).
 * discard: nothing landed here — both the text and the marker are marked deleted.
 *
 * warmFonts: resolves once the fonts every measurement depends on are loaded — one throwaway measurement (which is
 * what makes the library register the webfont at all) and then `document.fonts.ready`. Idempotent and cached: the
 * controller awaits it before it arms, so no transcript is ever fitted against fallback metrics.
 */
export interface FitModule {
  buildPlaceholder(shape: StrokeShape, style: StyleSnapshot, opts?: FitOptions): PlaceholderResult;
  buildPlaceholderFor(container: ExcalidrawElement, style: StyleSnapshot, opts?: FitOptions): PlaceholderResult;
  setPlaceholderFrame(text: ExcalidrawTextElement, frame: number): ExcalidrawTextElement;
  commitText(
    target: VoiceTarget,
    text: ExcalidrawTextElement,
    transcript: string,
    style: StyleSnapshot,
    marker?: ExcalidrawElement | null,
    opts?: FitOptions,
  ): ExcalidrawElement[];
  commitInterim(
    target: VoiceTarget,
    text: ExcalidrawTextElement,
    transcript: string,
    style: StyleSnapshot,
    marker?: ExcalidrawElement | null,
    opts?: FitOptions,
  ): ExcalidrawElement[];
  resetPlaceholder(
    target: VoiceTarget,
    marker: ExcalidrawElement | null,
    text: ExcalidrawTextElement,
    style: StyleSnapshot,
    opts?: FitOptions,
  ): ExcalidrawElement[];
  markFailed(
    target: VoiceTarget,
    marker: ExcalidrawElement | null,
    text: ExcalidrawTextElement,
    style: StyleSnapshot,
  ): ExcalidrawElement[];
  discard(
    target: VoiceTarget,
    marker: ExcalidrawElement | null,
    text: ExcalidrawTextElement,
    style: StyleSnapshot,
  ): ExcalidrawElement[];
  warmFonts(fontFamily?: number): Promise<void>;
  /** Plain text at a point (no region): used when speech arrives without a stroke. */
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
  /** "" = auto-detect. Only "" | "ko" | "en" (settings.ts ALLOWED_LANGUAGES); the STT server refuses the rest. */
  language: string;
  prompt: string;
  deviceId: string; // "" = default mic
  maxFontSize: number;
  lineMaxFontSize: number;
  lineMinFontSize: number;
  /** Utterances shorter than this are dropped (whisper hallucinates on near-silence). */
  minSegmentMs: number;
  /** Speech may start this long before its stroke's pointer-down and still belong to it. */
  preRollMs: number;
  /**
   * How often, while an utterance is still OPEN, a partial cut of it is transcribed so the words appear before the
   * speaker stops (round 5). 0 = off. An interim result is cosmetic: it is never a committed part, never counted in
   * `completed`, never toasted, and the final transcript of the utterance always supersedes it.
   */
  interimMs: number;
  /** Energy VAD floor (RMS 0..1); the effective threshold is max(this, 3 × measured noise floor). */
  vadThreshold: number;
  /** Acquire the microphone at page load so the first arm is instant. The e2e turns this off to time fixtures. */
  warmMicOnBoot: boolean;
}
/** The GPU box that runs faster-whisper (desktop-woo on the tailnet); reachable over plain HTTP only. */
export const STT_DIRECT_URL = "http://100.81.33.83:8770";

/**
 * Where THIS page reaches the STT server. On the wall kiosk the page is plain HTTP on loopback, so it dials the
 * desktop directly. Everywhere else the board is served over HTTPS (Tailscale Serve, board.euidos.ai), and a browser
 * refuses a plain-HTTP fetch from an HTTPS page as mixed content, so nginx in front of the hosted board proxies the
 * server same-origin at `/stt/` (fleet-infra stacks/euidos-internal/nginx.conf). Takes the location explicitly so it
 * can be unit-tested outside a browser.
 */
export function defaultSttUrl(
  loc: { hostname: string; origin: string } | undefined = typeof location === "undefined" ? undefined : location,
): string {
  if (!loc || loc.hostname === "localhost" || loc.hostname === "127.0.0.1" || loc.hostname === "") {
    return STT_DIRECT_URL;
  }
  return `${loc.origin}/stt`;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  sttUrl: defaultSttUrl(),
  language: "",
  prompt: "",
  deviceId: "",
  maxFontSize: 96,
  lineMaxFontSize: 36,
  lineMinFontSize: 14,
  minSegmentMs: 400,
  preRollMs: 1500,
  interimMs: 1200,
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
  /**
   * True between `onUtteranceStart` and `onUtteranceEnd`: the VAD has decided the current sound IS speech and the
   * audio is being kept for a transcript. `recording` only says the microphone is open, which on a wall panel is
   * indistinguishable from a dead mic — this is the field a surface draws to answer "is it hearing me right now".
   * Always false while `mode === "idle"` (disarming closes every open utterance).
   */
  speaking: boolean;
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
  /**
   * Round trip of the last FINAL transcription that came back (`SttResult.latencyMs`). Diagnostics only: it is what
   * makes "the words appeared 80 ms after pen-up" comparable with "the server took 950 ms", which is the whole
   * claim of round 5 — before it, that server time was paid after pen-up.
   */
  lastSttLatencyMs?: number;
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

/** Tools whose freshly drawn element becomes the region marker directly (modifier behaviour). */
export const NATIVE_CONTAINER_TOOLS = ["rectangle", "ellipse", "diamond", "line"] as const;

/** toolbar.tsx — DOM injection next to the native shape buttons. */
export interface ToolbarHandle { update(status: VoiceStatus): void; unmount(): void }
export interface ToolbarOptions {
  onToggle: () => void;
  onRetry: () => void;
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
