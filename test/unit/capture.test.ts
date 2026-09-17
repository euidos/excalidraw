/**
 * Capture gates for the two states the wall panel can get stuck in: a microphone that errored once and can never
 * be re-armed, and a cold audio HAL whose slow-but-successful resume was reported as a permanent failure.
 * The audio graph is faked (node has no Web Audio); only the state machine around it is under test.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createVoiceCapture } from "../../src/capture";
import type { MicState } from "../../src/contracts-capture";

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
  createScriptProcessor(): ReturnType<typeof node> {
    return node();
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

let capture: ReturnType<typeof createVoiceCapture> | null = null;
afterEach(() => {
  capture?.dispose();
  capture = null;
});

describe("prepare() — a cached microphone must not confirm its own error forever", () => {
  it("re-validates an intact graph instead of returning the stale error state", async () => {
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

  it("tears the cached graph down and rebuilds when the context is no longer running", async () => {
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
  it("clears back to ok when the context runs after the old 500 ms grace period", async () => {
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

  it("still reports the failure once the whole window has elapsed", async () => {
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
