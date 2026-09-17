/**
 * vad.ts — the energy VAD as a pure state machine.
 *
 * It sees one RMS value per 20 ms frame and nothing else: no DOM, no timers, no audio. capture.ts owns the ring
 * buffer and the capture clock and converts the sample indices returned here into ms, so every boundary decision
 * stays unit-testable in-process (RETRO L1: geometry/logic that can be tested in-process is never tested through
 * the browser).
 *
 * Boundaries are reported as SAMPLE indices, counted from the first sample the capture ring ever wrote, because
 * that is the only quantity both sides agree on exactly; ms are derived, and derived late, so a drifting clock
 * offset cannot move an already-decided boundary.
 */
import type { VadOptions } from "./contracts-capture";

/**
 * `sample` / `startSample` are inclusive (the first sample of the first loud frame); `endSample` is exclusive
 * (the end of the last loud frame), so endSample − startSample is exactly the audio the speaker was loud for.
 */
export type VadEvent =
  | { type: "start"; id: number; sample: number }
  | { type: "end"; id: number; startSample: number; endSample: number };

export interface Vad {
  /** @param frameIndex frame number since capture started; frames are contiguous while the VAD is running. */
  pushFrame(rms: number, frameIndex: number): VadEvent[];
  /**
   * Forget the run state: any open utterance is dropped without an end event. The measured noise floor is KEPT —
   * the room is not run state, and re-measuring it at the moment the user arms would spend the first 200 ms of
   * every take deaf (or, if they are already talking, seed the floor from their voice and stay deaf).
   */
  reset(): void;
  setOptions(opts: VadOptions & { sampleRate?: number }): void;
}

export type VadCreateOptions = VadOptions & { sampleRate?: number };

const FRAME_MS = 20;
/** The floor tracks the room, not the sentence: slow enough that a pause inside speech cannot raise it. */
const FLOOR_ALPHA = 0.05;
/** Frames averaged into the initial floor before any detection runs (200 ms of room tone). */
const SEED_FRAMES = 10;
/** Speech has to beat the room by this factor, so a noisy whiteboard raises the bar instead of self-triggering. */
const FLOOR_MULTIPLIER = 3;

const DEFAULTS = {
  threshold: 0.012,
  onsetMs: 120,
  hangoverMs: 700,
  maxUtteranceMs: 20000,
  sampleRate: 16000,
};

export function createVad(opts: VadCreateOptions = {}): Vad {
  let threshold = opts.threshold ?? DEFAULTS.threshold;
  let onsetMs = opts.onsetMs ?? DEFAULTS.onsetMs;
  let hangoverMs = opts.hangoverMs ?? DEFAULTS.hangoverMs;
  let maxUtteranceMs = opts.maxUtteranceMs ?? DEFAULTS.maxUtteranceMs;
  let sampleRate = opts.sampleRate ?? DEFAULTS.sampleRate;
  let frameSamples = Math.round((sampleRate * FRAME_MS) / 1000);

  /** Ids never restart, not even across reset(): a late event from a previous take must never alias a live one. */
  let nextId = 1;

  let seedFrames = 0;
  let seedSum = 0;
  let seeded = false;
  let noiseFloor = 0;

  // silence state
  let firstLoudFrame = -1;
  let loudRun = 0;

  // speech state
  let inSpeech = false;
  let openId = 0;
  let startSample = 0;
  let lastLoudFrame = -1;
  let silentRun = 0;

  const onsetFrames = () => Math.max(1, Math.ceil(onsetMs / FRAME_MS));
  const hangoverFrames = () => Math.max(1, Math.ceil(hangoverMs / FRAME_MS));
  const maxSamples = () => Math.round((maxUtteranceMs / 1000) * sampleRate);

  function clearRun(): void {
    firstLoudFrame = -1;
    loudRun = 0;
  }

  function openUtterance(sample: number, frameIndex: number, events: VadEvent[]): void {
    inSpeech = true;
    openId = nextId++;
    startSample = sample;
    lastLoudFrame = frameIndex;
    silentRun = 0;
    clearRun();
    events.push({ type: "start", id: openId, sample: startSample });
  }

  function closeUtterance(endSample: number, events: VadEvent[]): void {
    inSpeech = false;
    silentRun = 0;
    lastLoudFrame = -1;
    clearRun();
    events.push({ type: "end", id: openId, startSample, endSample: Math.max(endSample, startSample) });
  }

  return {
    pushFrame(rms: number, frameIndex: number): VadEvent[] {
      const events: VadEvent[] = [];

      // Detection cannot start before the room is measured, or the first frames of a loud room read as speech.
      if (!seeded) {
        seedSum += rms;
        seedFrames++;
        if (seedFrames >= SEED_FRAMES) {
          noiseFloor = seedSum / seedFrames;
          seeded = true;
        }
        return events;
      }

      const level = Math.max(0, rms);
      const effective = Math.max(threshold, FLOOR_MULTIPLIER * noiseFloor);
      const loud = level > effective;
      // Only quiet frames outside an utterance are room tone; a pause mid-sentence is not.
      if (!loud && !inSpeech) noiseFloor += FLOOR_ALPHA * (level - noiseFloor);

      if (inSpeech && frameIndex * frameSamples - startSample >= maxSamples()) {
        // Force split: the frames up to here are one utterance, this frame starts the next one (if still loud).
        closeUtterance(Math.min(lastLoudFrame + 1, frameIndex) * frameSamples, events);
        if (loud) {
          openUtterance(frameIndex * frameSamples, frameIndex, events);
          return events;
        }
      }

      if (inSpeech) {
        if (loud) {
          lastLoudFrame = frameIndex;
          silentRun = 0;
        } else if (++silentRun >= hangoverFrames()) {
          closeUtterance((lastLoudFrame + 1) * frameSamples, events);
        }
        return events;
      }

      if (!loud) {
        clearRun();
        return events;
      }
      if (firstLoudFrame < 0) {
        firstLoudFrame = frameIndex;
        loudRun = 0;
      }
      // The onset is the FIRST loud frame, not the frame that confirmed it — otherwise every utterance loses its
      // first 120 ms, which is where the consonant lives.
      if (++loudRun >= onsetFrames()) openUtterance(firstLoudFrame * frameSamples, frameIndex, events);
      return events;
    },

    reset(): void {
      inSpeech = false;
      silentRun = 0;
      lastLoudFrame = -1;
      startSample = 0;
      clearRun();
    },

    setOptions(next: VadCreateOptions): void {
      if (next.threshold !== undefined) threshold = next.threshold;
      if (next.onsetMs !== undefined) onsetMs = next.onsetMs;
      if (next.hangoverMs !== undefined) hangoverMs = next.hangoverMs;
      if (next.maxUtteranceMs !== undefined) maxUtteranceMs = next.maxUtteranceMs;
      if (next.sampleRate !== undefined) {
        sampleRate = next.sampleRate;
        frameSamples = Math.round((sampleRate * FRAME_MS) / 1000);
      }
    },
  };
}

export default createVad;
