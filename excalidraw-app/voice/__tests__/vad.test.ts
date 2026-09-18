import { describe, expect, it } from "vitest";
import { encodeWav } from "../capture";
import createVadDefault, { createVad, type Vad, type VadEvent } from "../vad";

const FRAME_MS = 20;
const RATE = 16000;
const FRAME = (RATE * FRAME_MS) / 1000; // 320 samples

/** One entry per emitted event, with the frame that emitted it — onset timing is half of what we assert. */
interface Emitted {
  frame: number;
  event: VadEvent;
}

function level(count: number, rms: number): number[] {
  return Array.from({ length: count }, () => rms);
}

/** Feeds frames with contiguous indices, the way capture.ts does while active. */
function feed(vad: Vad, frames: number[], firstFrame = 0): Emitted[] {
  const out: Emitted[] = [];
  frames.forEach((rms, i) => {
    const frame = firstFrame + i;
    for (const event of vad.pushFrame(rms, frame)) out.push({ frame, event });
  });
  return out;
}

const SILENCE = 0.001;
const SPEECH = 0.2;
/** 10 seed frames + headroom: detection only starts once the room has been measured. */
const LEAD_IN = 30;
/** 700 ms hangover = 35 frames; 60 closes any open utterance. */
const TAIL = 60;

function starts(emitted: Emitted[]): Array<Extract<VadEvent, { type: "start" }>> {
  return emitted.map(e => e.event).filter((e): e is Extract<VadEvent, { type: "start" }> => e.type === "start");
}
function ends(emitted: Emitted[]): Array<Extract<VadEvent, { type: "end" }>> {
  return emitted.map(e => e.event).filter((e): e is Extract<VadEvent, { type: "end" }> => e.type === "end");
}

describe("createVad", () => {
  it("emits nothing for silence only", () => {
    const emitted = feed(createVad(), level(500, SILENCE));
    expect(emitted).toEqual([]);
  });

  it("brackets a 1 s burst with one utterance whose onset is the first loud frame", () => {
    const emitted = feed(createVad(), [...level(LEAD_IN, SILENCE), ...level(50, SPEECH), ...level(TAIL, SILENCE)]);
    expect(starts(emitted)).toEqual([{ type: "start", id: 1, sample: LEAD_IN * FRAME }]);
    expect(ends(emitted)).toEqual([
      { type: "end", id: 1, startSample: LEAD_IN * FRAME, endSample: (LEAD_IN + 50) * FRAME },
    ]);
    // Confirmed 120 ms (6 frames) after the first loud frame, but timestamped back at it.
    expect(emitted[0].frame).toBe(LEAD_IN + 5);
    // Closed one hangover (35 frames) after the last loud frame.
    expect(emitted[1].frame).toBe(LEAD_IN + 50 + 34);
    const utterance = ends(emitted)[0];
    expect(((utterance.endSample - utterance.startSample) / RATE) * 1000).toBe(1000);
  });

  it("keeps two bursts 400 ms apart (under the hangover) in one utterance", () => {
    const emitted = feed(createVad(), [
      ...level(LEAD_IN, SILENCE),
      ...level(25, SPEECH),
      ...level(20, SILENCE), // 400 ms < 700 ms hangover
      ...level(25, SPEECH),
      ...level(TAIL, SILENCE),
    ]);
    expect(starts(emitted)).toHaveLength(1);
    expect(ends(emitted)).toEqual([
      { type: "end", id: 1, startSample: LEAD_IN * FRAME, endSample: (LEAD_IN + 70) * FRAME },
    ]);
  });

  it("splits two bursts 1 s apart into two utterances with monotonic ids", () => {
    const emitted = feed(createVad(), [
      ...level(LEAD_IN, SILENCE),
      ...level(25, SPEECH),
      ...level(50, SILENCE), // 1 s > 700 ms hangover
      ...level(25, SPEECH),
      ...level(TAIL, SILENCE),
    ]);
    expect(starts(emitted).map(e => e.id)).toEqual([1, 2]);
    expect(ends(emitted)).toEqual([
      { type: "end", id: 1, startSample: LEAD_IN * FRAME, endSample: (LEAD_IN + 25) * FRAME },
      { type: "end", id: 2, startSample: (LEAD_IN + 75) * FRAME, endSample: (LEAD_IN + 100) * FRAME },
    ]);
  });

  it("force-splits a 25 s burst at maxUtteranceMs and opens the next utterance immediately", () => {
    const emitted = feed(createVad(), [
      ...level(LEAD_IN, SILENCE),
      ...level(1250, SPEECH), // 25 s
      ...level(TAIL, SILENCE),
    ]);
    expect(starts(emitted).map(e => e.id)).toEqual([1, 2]);
    const [first, second] = ends(emitted);
    expect(first).toEqual({
      type: "end",
      id: 1,
      startSample: LEAD_IN * FRAME,
      endSample: (LEAD_IN + 1000) * FRAME, // exactly 20 s
    });
    expect((first.endSample - first.startSample) / RATE).toBe(20);
    expect(second).toEqual({
      type: "end",
      id: 2,
      startSample: (LEAD_IN + 1000) * FRAME,
      endSample: (LEAD_IN + 1250) * FRAME,
    });
    // No gap and no overlap between the halves of the split.
    expect(second.startSample).toBe(first.endSample);
  });

  it("ignores a burst shorter than onsetMs", () => {
    const emitted = feed(createVad(), [
      ...level(LEAD_IN, SILENCE),
      ...level(5, SPEECH), // 100 ms < 120 ms
      ...level(TAIL, SILENCE),
    ]);
    expect(emitted).toEqual([]);
  });

  it("does not trigger on a room whose own noise floor sits above the raw threshold", () => {
    // floor seeds to 0.02, so the effective threshold is 3 × 0.02 = 0.06 and steady 0.02 is never speech.
    const emitted = feed(createVad(), level(300, 0.02));
    expect(emitted).toEqual([]);
  });

  it("applies a lowered threshold from setOptions live", () => {
    const vad = createVad();
    const quietSpeech = 0.008; // under the 0.012 default, over a 0.004 override
    expect(feed(vad, [...level(10, 0.0005), ...level(4, quietSpeech)])).toEqual([]);
    vad.setOptions({ threshold: 0.004 });
    const emitted = feed(vad, level(20, quietSpeech), 14);
    expect(starts(emitted)).toEqual([{ type: "start", id: 1, sample: 14 * FRAME }]);
  });

  it("honours onsetMs, hangoverMs and a non-default sampleRate", () => {
    const vad = createVad({ onsetMs: 40, hangoverMs: 100, sampleRate: 8000 });
    const frame = (8000 * FRAME_MS) / 1000; // 160 samples
    const emitted = feed(vad, [...level(LEAD_IN, SILENCE), ...level(3, SPEECH), ...level(10, SILENCE)]);
    expect(ends(emitted)).toEqual([
      { type: "end", id: 1, startSample: LEAD_IN * frame, endSample: (LEAD_IN + 3) * frame },
    ]);
    expect(emitted[0].frame).toBe(LEAD_IN + 1); // 40 ms = 2 frames to confirm
    expect(emitted[1].frame).toBe(LEAD_IN + 3 + 4); // 100 ms = 5 frames of silence to close
  });

  it("drops an open utterance on reset and never reuses an id", () => {
    const vad = createVad();
    const first = feed(vad, [...level(LEAD_IN, SILENCE), ...level(25, SPEECH)]);
    expect(starts(first).map(e => e.id)).toEqual([1]);
    expect(ends(first)).toEqual([]); // still open
    vad.reset();
    const second = feed(vad, [...level(LEAD_IN, SILENCE), ...level(25, SPEECH), ...level(TAIL, SILENCE)], 1000);
    expect(starts(second).map(e => e.id)).toEqual([2]);
    expect(ends(second).map(e => e.id)).toEqual([2]);
  });

  it("exports the factory as the default export", () => {
    expect(createVadDefault).toBe(createVad);
  });
});

/**
 * The monorepo's vitest environment is jsdom, whose Blob has no `arrayBuffer()` (the wrapper's own
 * suite ran in node, where it does). FileReader is what jsdom implements, so read through it and keep
 * the native path when one exists — the bytes under test are encodeWav's, not the environment's.
 */
const blobBytes = async (blob: Blob): Promise<ArrayBuffer> => {
  if (typeof blob.arrayBuffer === "function") {
    return await blob.arrayBuffer();
  }
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsArrayBuffer(blob);
  });
};

describe("encodeWav", () => {
  const readHeader = async (blob: Blob) => {
    const view = new DataView(await blobBytes(blob));
    const text = (offset: number, length: number) =>
      String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));
    return { view, text };
  };

  it("writes a 44-byte 16-bit mono PCM header", async () => {
    const blob = encodeWav(new Float32Array(160), RATE);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 160 * 2);
    const { view, text } = await readHeader(blob);
    expect(text(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 320);
    expect(text(8, 4)).toBe("WAVE");
    expect(text(12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint32(28, true)).toBe(RATE * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(text(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(320);
  });

  it("clamps and scales samples, and carries the sample rate it was given", async () => {
    const blob = encodeWav(new Float32Array([0, 1, -1, 0.5, 2, -2]), 8000);
    expect(blob.size).toBe(44 + 12);
    const { view } = await readHeader(blob);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(28, true)).toBe(16000);
    expect([0, 1, 2, 3, 4, 5].map(i => view.getInt16(44 + i * 2, true))).toEqual([
      0,
      32767,
      -32768,
      Math.round(0.5 * 0x7fff),
      32767,
      -32768,
    ]);
  });

  it("encodes an empty cut as a header-only WAV", async () => {
    const blob = encodeWav(new Float32Array(0), RATE);
    expect(blob.size).toBe(44);
    const { view } = await readHeader(blob);
    expect(view.getUint32(40, true)).toBe(0);
  });
});

describe("createVad.reset", () => {
  it("keeps the measured noise floor so a take can start mid-word", () => {
    const vad = createVad();
    feed(vad, level(LEAD_IN, SILENCE)); // the room, measured while the tool was idle
    vad.reset();
    // No lead-in this time: if reset re-seeded, these ten frames would seed the floor from the voice and the
    // whole take would be deaf.
    const emitted = feed(vad, [...level(25, SPEECH), ...level(TAIL, SILENCE)], 1000);
    expect(starts(emitted)).toEqual([{ type: "start", id: 1, sample: 1000 * FRAME }]);
    expect(ends(emitted)[0].endSample).toBe(1025 * FRAME);
  });
});
