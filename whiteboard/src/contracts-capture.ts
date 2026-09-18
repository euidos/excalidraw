/**
 * Round-2 contracts: PCM capture with an energy VAD, and utterance→stroke assignment.
 * Replaces the MediaRecorder segmenting of round 1 (see REF-hate-round1.local.md for why): utterances are atomic,
 * WAV segments contain only speech, and a label spoken shortly BEFORE its stroke still lands in that stroke.
 */
import type { MicState } from "./contracts";

export type { MicState };

export interface UtteranceEvent {
  id: number;
  /** capture-clock ms (see VoiceCapture.now) */
  onsetMs: number;
  endMs?: number;
}
export interface VadOptions {
  /** RMS floor (0..1) below which a frame is silence; the effective threshold is max(threshold, 3 × noise floor). Default 0.012. */
  threshold?: number;
  /** Speech must persist this long to open an utterance. Default 120. */
  onsetMs?: number;
  /** Silence must persist this long to close an utterance. Default 700. */
  hangoverMs?: number;
  /** Audio added before onset / after end in the WAV. Default 250. */
  padMs?: number;
  /** Utterances shorter than this are discarded (whisper hallucinates on them). Default 400. */
  minUtteranceMs?: number;
  /** Force-close an utterance at this length. Default 20000. */
  maxUtteranceMs?: number;
}
export interface CaptureOptions {
  /** Output sample rate for WAV (the AudioContext rate is resampled down to this). Default 16000. */
  sampleRate?: number;
  /** Ring buffer length. Default 300 s. */
  bufferSeconds?: number;
  vad?: VadOptions;
}
/**
 * capture.ts — one long-lived MediaStream → AudioWorklet (or ScriptProcessor fallback) → Float32 ring buffer at
 * `sampleRate` + energy VAD on 20 ms frames. `now()` is the capture clock in ms (performance.now()-based, same
 * clock the controller stamps pointer events with). `wav(from, to)` cuts a 16-bit mono WAV out of the ring buffer.
 * start() begins VAD + buffering (idempotent); stop() closes any open utterance (onUtteranceEnd fires) and pauses
 * VAD but keeps the stream so the next start() is instant. Utterance ids increase monotonically.
 */
export interface VoiceCapture {
  prepare(deviceId?: string): Promise<MicState>;
  start(): Promise<void>;
  stop(): Promise<void>;
  wav(fromMs: number, toMs: number): Blob;
  now(): number;
  readonly mic: MicState;
  readonly active: boolean;
  /**
   * The VAD's measured room tone, RAW RMS on the same scale as `onLevel` (0 until the first ~200 ms are seeded).
   * Exposed because the effective VAD threshold is max(setting, 3 x floor): a settings panel that draws only the
   * setting draws a line the VAD is not using.
   */
  readonly noiseFloor: number;
  onUtteranceStart?: (u: UtteranceEvent) => void;
  onUtteranceEnd?: (u: Required<UtteranceEvent>) => void;
  /**
   * Room loudness for the meter, ~10x/s while a take is running.
   *
   * UNIT AND SCALE (RETRO L6 / gate N12): RAW RMS in 0..1, exactly the number the VAD thresholds against — a quiet
   * room reads ~0.003..0.006, speech ~0.02..0.2. No display gain is applied here, because the only consumer that
   * can choose one is the surface that draws it: `src/level.ts` owns that mapping so the meter bar and the VAD
   * threshold marker cannot end up on two different axes again.
   */
  onLevel?: (rms: number) => void;
  /** Fires on every mic state change: prepare() outcome, track ended/muted mid-take, device fallback. */
  onMicChange?: (mic: MicState, detail?: string) => void;
  /** Change VAD parameters at runtime (settings panel). */
  setVad(opts: VadOptions): void;
  dispose(): void;
}
export type CreateVoiceCapture = (opts?: CaptureOptions) => VoiceCapture;

/** assign.ts — pure, unit-tested. */
export interface StrokeRecord {
  /** the VoiceTarget.textId of the shape the stroke produced */
  id: string;
  downMs: number;
  upMs?: number;
}
export interface Utterance { id: number; onsetMs: number; endMs: number }
export interface AssignOptions {
  /** Speech may begin this long before its stroke's pointer-down and still belong to it. Default 1500. */
  preRollMs?: number;
}
export interface Assignment {
  /** null = no stroke can claim it (orphan) */
  strokeId: string | null;
  /** true once no future stroke could still claim the utterance (nowMs ≥ onsetMs + preRollMs) */
  final: boolean;
}
/**
 * Rule: candidates are strokes with downMs ≤ onsetMs + preRollMs; the latest candidate wins. An utterance that
 * starts before any stroke and outlives the pre-roll is an orphan. Assignment is only actionable when `final`.
 */
export type AssignUtterance = (u: Utterance, strokes: readonly StrokeRecord[], nowMs: number, opts?: AssignOptions) => Assignment;

/** Transcripts that whisper produces from near-silence; matched after trimming/punctuation stripping, case-insensitive. */
export const HALLUCINATION_BLOCKLIST = [
  "감사합니다", "시청해주셔서 감사합니다", "시청해 주셔서 감사합니다", "구독과 좋아요", "자막 제공", "자막 by",
  "뉴스", "MBC 뉴스", "KBS 뉴스",
  "thank you", "thanks for watching", "thank you for watching", "you", "bye", "subtitles by", "amara.org",
  "subtitles by amara.org", "subtitles by the amara.org community",
];
/**
 * Only multi-word entries get the fuzzy substring match. A short entry ("you", "bye", "뉴스") is a substring of
 * ordinary words — "young", "payout", "뉴스룸" — and the controller drops a filtered transcript with no ⚠ and no
 * retry, so a loose match here deletes real speech invisibly. Short entries must therefore match exactly.
 */
const SUBSTRING_MIN_LENGTH = 8;

/** Spacing is not a word boundary in Korean and whisper punts on it ("시청해주셔서" vs "시청해 주셔서"). */
const despace = (s: string): string => s.replace(/\s+/g, "");

export function isHallucination(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?,、。…\s]+$/g, "").replace(/^[\s.!?,]+/, "");
  if (!t) return true;
  const squashed = despace(t);
  return HALLUCINATION_BLOCKLIST.some(entry => {
    const b = entry.toLowerCase();
    if (t === b) return true;
    // Whole-text equality ignoring spaces: an exact match, so it is safe for the short entries too.
    if (squashed === despace(b)) return true;
    return b.length >= SUBSTRING_MIN_LENGTH && t.length <= b.length + 3 && t.includes(b);
  });
}
