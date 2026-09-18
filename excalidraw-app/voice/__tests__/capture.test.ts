/**
 * Capture gates for the states the wall panel can get stuck in (gate N11: every blocking state is entered, the
 * cause is cleared, and the product works again WITHOUT a reload — the panel has no keyboard and no one to press
 * F5), plus the unit the level meter is drawn from (gate N12).
 * The audio graph is faked (node has no Web Audio); only the state machine around it is under test.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createVoiceCapture } from "../capture";
import type { MicState } from "../contracts-capture";

class FakeTrack {
  readyState: "live" | "ended" = "live";
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  stop(): void {
    this.readyState = "ended";
  }
}

class FakeStream {
  track = new FakeTrack();
  getTracks(): FakeTrack[] {
    return [this.track];
  }
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
}

const node = () => ({ connect: () => undefined, disconnect: () => undefined, onaudioprocess: null });

class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  state: "running" | "suspended" | "closed";
  sampleRate = 48_000;
  destination = node();
  /** Left undefined so capture.ts takes the ScriptProcessor path (no AudioWorklet in node). */
  audioWorklet: undefined = undefined;
  /** Set by a test to make resume() land later than the old 500 ms grace period. */
  resumeAfterMs = 0;

  constructor(state: "running" | "suspended" = "running") {
    this.state = state;
    FakeAudioContext.created.push(this);
  }
  createMediaStreamSource(): ReturnType<typeof node> {
    return node();
  }
  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 0 }, connect: () => undefined, disconnect: () => undefined };
  }
  /** Kept so a test can hand the capture a chunk of PCM the way the real node would. */
  processor: ReturnType<typeof node> | null = null;
  createScriptProcessor(): ReturnType<typeof node> {
    this.processor = node();
    return this.processor;
  }
  async resume(): Promise<void> {
    if (this.resumeAfterMs === 0) {
      this.state = "running";
      return;
    }
    // The HAL answers eventually; the caller's await resolves long before the state flips.
    setTimeout(() => {
      if (this.state === "suspended") this.state = "running";
    }, this.resumeAfterMs);
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
}

interface Rig {
  streams: FakeStream[];
  calls: number;
  nextState: "running" | "suspended";
  resumeAfterMs: number;
}

const rig: Rig = { streams: [], calls: 0, nextState: "running", resumeAfterMs: 0 };

function install(): void {
  rig.streams = [];
  rig.calls = 0;
  rig.nextState = "running";
  rig.resumeAfterMs = 0;
  FakeAudioContext.created = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (): Promise<FakeStream> => {
          rig.calls += 1;
          const stream = new FakeStream();
          rig.streams.push(stream);
          return stream;
        },
      },
    },
  });
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = class extends FakeAudioContext {
    constructor() {
      super(rig.nextState);
      this.resumeAfterMs = rig.resumeAfterMs;
    }
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One 2048-sample chunk of constant-amplitude audio: RMS is exactly `amplitude`, before and after resampling. */
function feed(amplitude: number, chunks = 1): void {
  const ctx = FakeAudioContext.created.at(-1)!;
  const data = new Float32Array(2048).fill(amplitude);
  const handler = (ctx.processor as unknown as { onaudioprocess: ((e: unknown) => void) | null }).onaudioprocess;
  for (let i = 0; i < chunks; i++) {
    handler?.({ inputBuffer: { getChannelData: () => data } });
  }
}

let capture: ReturnType<typeof createVoiceCapture> | null = null;
afterEach(() => {
  capture?.dispose();
  capture = null;
});

describe("prepare() — a cached microphone must not confirm its own error forever", () => {
  it("N11(c): re-checks an intact graph instead of returning the latched error state", async () => {
    install();
    const seen: MicState[] = [];
    capture = createVoiceCapture();
    capture.onMicChange = (mic) => seen.push(mic);

    expect(await capture.prepare()).toBe("ok");
    // A transient mute (a headset switch, a panel sleep) parks the module in "error".
    rig.streams[0]!.track.onmute?.();
    expect(capture.mic).toBe("error");

    // Tapping the latch again must be able to recover: the stream and context are still alive and running.
    expect(await capture.prepare()).toBe("ok");
    expect(capture.mic).toBe("ok");
    expect(rig.calls, "the live graph was reused, not re-acquired").toBe(1);
    expect(seen).toEqual(["ok", "error", "ok"]);
  });

  it("N11(c): tears the cached graph down and rebuilds when the context is no longer running", async () => {
    install();
    capture = createVoiceCapture();
    expect(await capture.prepare()).toBe("ok");

    // A context that died in the background (panel suspend) with the track still nominally live.
    FakeAudioContext.created[0]!.state = "suspended";
    rig.streams[0]!.track.onmute?.();
    expect(capture.mic).toBe("error");

    expect(await capture.prepare()).toBe("ok");
    expect(rig.calls, "a fresh getUserMedia + graph").toBe(2);
    expect(FakeAudioContext.created).toHaveLength(2);
  });
});

describe("start() — a slow resume is not an autoplay block", () => {
  it("N11(a): clears back to ok when the context runs after the old 500 ms grace period", async () => {
    install();
    rig.nextState = "suspended";
    rig.resumeAfterMs = 900;
    const seen: MicState[] = [];
    capture = createVoiceCapture();
    capture.onMicChange = (mic) => seen.push(mic);

    await capture.prepare();
    await capture.start();
    await wait(1400);

    expect(capture.mic, "the cold HAL landed; the tool stays armable").toBe("ok");
    expect(seen, "no spurious error on the way").toEqual(["ok"]);
    expect(capture.active).toBe(true);
  });

  it("N11(a): still reports the failure once the whole window has elapsed", async () => {
    install();
    rig.nextState = "suspended";
    rig.resumeAfterMs = 60_000; // never, for the purposes of this test
    const seen: [MicState, string | undefined][] = [];
    capture = createVoiceCapture();
    capture.onMicChange = (mic, detail) => seen.push([mic, detail]);

    await capture.prepare();
    await capture.start();
    await wait(1000);
    expect(capture.mic, "no verdict while the window is still open").toBe("ok");

    await wait(2600);
    expect(capture.mic).toBe("error");
    expect(seen.at(-1)).toEqual(["error", "audio context suspended"]);
  }, 10_000);
});

describe("N11(a) — an audio context that stays suspended past the window and then comes back", () => {
  it("goes error, then ok, and arms again without a reload", async () => {
    install();
    rig.nextState = "suspended";
    rig.resumeAfterMs = 60_000; // the HAL is asleep for longer than the whole resume window
    const seen: MicState[] = [];
    capture = createVoiceCapture();
    capture.onMicChange = (mic) => seen.push(mic);

    await capture.prepare();
    await capture.start();
    await wait(3_400);
    expect(capture.mic, "the window elapsed with the context still suspended").toBe("error");

    await capture.stop();
    expect(capture.active).toBe(false);

    // The founder taps the latch again after the panel wakes up: the context is running now.
    FakeAudioContext.created.at(-1)!.state = "running";
    await capture.start();

    expect(capture.mic, "the error cleared with its cause").toBe("ok");
    expect(capture.active, "and the take actually started").toBe(true);
    expect(rig.calls, "no new getUserMedia: no permission prompt, no reload").toBe(1);
    expect(seen).toEqual(["ok", "error", "ok"]);
  }, 15_000);
});

describe("N11(b) — a muted track", () => {
  it("errors on mute, clears on unmute, and starts again", async () => {
    install();
    const seen: [MicState, string | undefined][] = [];
    capture = createVoiceCapture();
    capture.onMicChange = (mic, detail) => seen.push([mic, detail]);

    expect(await capture.prepare()).toBe("ok");
    const track = rig.streams[0]!.track;

    track.onmute?.();
    expect(capture.mic).toBe("error");
    expect(seen.at(-1)).toEqual(["error", "microphone muted"]);

    track.onunmute?.();
    expect(capture.mic, "the mute ended; the tool must not stay refused").toBe("ok");

    await capture.start();
    expect(capture.active).toBe(true);
    expect(rig.calls, "the same stream, no re-acquisition").toBe(1);
  });
});

describe("N12 — the number the meter is drawn from", () => {
  it("emits RAW RMS through onLevel, not a display-gained copy of it", async () => {
    install();
    const levels: number[] = [];
    capture = createVoiceCapture();
    capture.onLevel = (rms) => levels.push(rms);
    await capture.prepare();
    await capture.start();

    // Constant 0.1 amplitude: RMS is 0.1. Round 2 emitted 0.4 here (RMS x 4) while the panel drew the VAD
    // threshold on the raw axis, so the bar read four times the room it was being compared against.
    feed(0.1);
    expect(levels[0]).toBeCloseTo(0.1, 3);
  });

  it("reports the VAD's noise floor on that same scale", async () => {
    install();
    const levels: number[] = [];
    capture = createVoiceCapture();
    capture.onLevel = (rms) => levels.push(rms);
    await capture.prepare();
    await capture.start();
    expect(capture.noiseFloor, "nothing measured yet").toBe(0);

    // 6 chunks is ~2000 output samples per chunk-triple: enough 20 ms frames to seed the floor from the room.
    feed(0.004, 6);
    expect(capture.noiseFloor, "the room, in RMS").toBeCloseTo(0.004, 3);
    expect(levels[0], "and the meter is fed the same unit").toBeCloseTo(0.004, 3);
  });
});
