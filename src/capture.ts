/**
 * capture.ts — one long-lived MediaStream → AudioWorklet → Float32 ring buffer at 16 kHz, plus the energy VAD.
 *
 * Round 1 cut audio at pointer-down with one MediaRecorder per segment, which made a label spoken just before its
 * stroke land in the previous shape and made every mixed-language window transcribe as one language. Here PCM is
 * buffered continuously from the moment the mic is prepared (so pre-roll speech already exists when the stroke
 * arrives) and the VAD only decides where the *speech* is; the controller decides which stroke owns it.
 *
 * Units: the ring is indexed in output samples since capture began; `now()` is performance.now() ms — the same
 * clock the controller stamps pointer events with. The two are related by a single slowly-updated offset, so a
 * timestamp and a sample index can always be converted both ways without asking the audio graph anything.
 *
 * Failure is a channel, never a field (RETRO L2): every mic transition — prepare outcome, device fallback, track
 * ended/muted, a context that will not resume — is pushed through `onMicChange` as well as being readable as
 * `.mic`.
 */
import type {
  CaptureOptions,
  CreateVoiceCapture,
  MicState,
  VadOptions,
  VoiceCapture,
} from "./contracts-capture";
import { createVad, type Vad, type VadEvent } from "./vad";

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_BUFFER_SECONDS = 300;
/** ~2048 samples per post keeps the main-thread work to ~20 messages/s at 48 kHz. */
const CHUNK_SAMPLES = 2048;
const FRAME_MS = 20;
const LEVEL_INTERVAL_MS = 100;
/** RMS of speech sits around 0.05..0.25; ×4 maps that onto a usable 0..1 meter. */
const LEVEL_GAIN = 4;
/** Chunks whose measured offset is taken as-is before the EMA takes over (also after a graph rebuild). */
const OFFSET_WARMUP_CHUNKS = 3;
const OFFSET_ALPHA = 0.1;
/**
 * A cold audio HAL (the wall panel on its first arm of the day) can take a second or more to hand a running
 * context back, so a single 500 ms verdict turned slow-but-successful resumes into a permanent error. The state is
 * polled instead: success as soon as it runs, failure only once the whole window has elapsed.
 */
const RESUME_POLL_MS = 250;
const RESUME_WINDOW_MS = 3000;

const WORKLET_NAME = "voice-capture-processor";

/**
 * The worklet module is shipped as a string and registered from a Blob URL: a separate .js entry would have to
 * survive the Vite build and the kiosk's asset paths, and this file is the only place that knows the contract
 * between the two sides (2048-sample Float32 chunks, buffer transferred, never copied).
 */
const WORKLET_SOURCE = `
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(${CHUNK_SAMPLES});
    this._n = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this._buf[this._n++] = channel[i];
        if (this._n === this._buf.length) {
          const full = this._buf;
          this._buf = new Float32Array(${CHUNK_SAMPLES});
          this._n = 0;
          this.port.postMessage(full.buffer, [full.buffer]);
        }
      }
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, VoiceCaptureProcessor);
`;

/** 16-bit PCM mono WAV. Pure, so the driver can assert the header without a browser. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate × blockAlign
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function micStateFor(err: unknown): MicState {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "missing";
  return "error";
}

function errorName(err: unknown): string {
  return (err as { name?: string } | null)?.name ?? "";
}

function constraintsFor(deviceId: string): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio };
}

export const createVoiceCapture: CreateVoiceCapture = (opts?: CaptureOptions): VoiceCapture => {
  const outRate = opts?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const capacity = Math.max(1, Math.round((opts?.bufferSeconds ?? DEFAULT_BUFFER_SECONDS) * outRate));
  const frameSamples = Math.max(1, Math.round((outRate * FRAME_MS) / 1000));

  const ring = new Float32Array(capacity);
  let totalSamplesWritten = 0;
  /** Samples already folded into VAD frames; frameIndex = framedSamples / frameSamples. */
  let framedSamples = 0;

  /** performance.now() ms of sample 0. Measured per chunk, smoothed, so a single late message cannot move it. */
  let offsetMs = 0;
  let offsetChunks = 0;

  const vad: Vad = createVad({ ...(opts?.vad ?? {}), sampleRate: outRate });
  let vadOptions: VadOptions = { ...(opts?.vad ?? {}) };

  let mic: MicState = "unknown";
  let active = false;

  let stream: MediaStream | null = null;
  let streamDeviceId = "";
  let requestedDeviceId = "";
  let preparing: Promise<MicState> | null = null;

  let ctx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let sink: GainNode | null = null;
  let workletUrl: string | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Resampler state (kept across chunks so the phase never restarts mid-stream).
  let ratio = 1;
  let integerRatio = 0;
  let accSum = 0;
  let accCount = 0;
  let prevSample = 0;
  let havePrev = false;
  let fracPos = 0;

  let levelSumSq = 0;
  let levelFrames = 0;
  let lastLevelAt = 0;

  /** The utterance the VAD currently has open, remembered so its end carries the onset the start reported. */
  let open: { id: number; onsetMs: number } | null = null;

  const capture: VoiceCapture = {
    prepare,
    start,
    stop,
    wav,
    now,
    setVad,
    dispose,
    get mic() {
      return mic;
    },
    get active() {
      return active;
    },
  };

  function now(): number {
    return performance.now();
  }

  function setMic(next: MicState, detail?: string): void {
    if (next === mic && detail === undefined) return;
    mic = next;
    capture.onMicChange?.(next, detail);
  }

  function sampleToMs(sample: number): number {
    return offsetMs + (sample * 1000) / outRate;
  }

  function sampleAt(tMs: number): number {
    return Math.round(((tMs - offsetMs) * outRate) / 1000);
  }

  // ---------------------------------------------------------------- audio path

  function resetResampler(rate: number): void {
    ratio = rate / outRate;
    const rounded = Math.round(ratio);
    // Integer ratios (48 k → 16 k is the common one) average N input samples: cheaper and it low-passes,
    // where plain decimation would alias room noise into the speech band.
    integerRatio = Math.abs(ratio - rounded) < 1e-6 && rounded >= 1 ? rounded : 0;
    accSum = 0;
    accCount = 0;
    prevSample = 0;
    havePrev = false;
    fracPos = 0;
    offsetChunks = 0;
  }

  function writeSample(value: number): void {
    ring[totalSamplesWritten % capacity] = value;
    totalSamplesWritten++;
  }

  function resampleInto(input: Float32Array): void {
    if (integerRatio === 1) {
      for (let i = 0; i < input.length; i++) writeSample(input[i]);
      return;
    }
    if (integerRatio > 1) {
      for (let i = 0; i < input.length; i++) {
        accSum += input[i];
        if (++accCount === integerRatio) {
          writeSample(accSum / integerRatio);
          accSum = 0;
          accCount = 0;
        }
      }
      return;
    }
    if (input.length === 0) return;
    if (!havePrev) {
      prevSample = input[0];
      havePrev = true;
      fracPos = 0;
    }
    // Virtual index 0 is the previous chunk's last sample, index i+1 is input[i]; fracPos carries the phase.
    const at = (index: number) => (index === 0 ? prevSample : input[index - 1]);
    while (Math.floor(fracPos) + 1 <= input.length) {
      const i = Math.floor(fracPos);
      const f = fracPos - i;
      writeSample(at(i) * (1 - f) + at(i + 1) * f);
      fracPos += ratio;
    }
    prevSample = input[input.length - 1];
    fracPos -= input.length;
  }

  function drainFrames(): void {
    while (totalSamplesWritten - framedSamples >= frameSamples) {
      const start = framedSamples;
      let sumSq = 0;
      for (let i = 0; i < frameSamples; i++) {
        const v = ring[(start + i) % capacity];
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / frameSamples);
      const frameIndex = start / frameSamples;
      framedSamples += frameSamples;
      if (active) {
        levelSumSq += sumSq;
        levelFrames += frameSamples;
      }
      // Frames are pushed whether or not a take is running: the VAD's noise floor has to be measured on the idle
      // room, not on the first 200 ms of the take. Only the *events* are gated by `active` (see handleVadEvents).
      handleVadEvents(vad.pushFrame(rms, frameIndex));
    }
    emitLevel();
  }

  function emitLevel(): void {
    if (!active || levelFrames === 0) return;
    const t = now();
    if (t - lastLevelAt < LEVEL_INTERVAL_MS) return;
    lastLevelAt = t;
    const rms = Math.sqrt(levelSumSq / levelFrames);
    levelSumSq = 0;
    levelFrames = 0;
    capture.onLevel?.(Math.min(1, Math.max(0, rms * LEVEL_GAIN)));
  }

  function handleVadEvents(events: VadEvent[]): void {
    for (const event of events) {
      if (event.type === "start") {
        // Speech that began before the user armed belongs to nobody; the controller only ever sees takes.
        if (!active) continue;
        const onsetMs = sampleToMs(event.sample);
        open = { id: event.id, onsetMs };
        capture.onUtteranceStart?.({ id: event.id, onsetMs });
      } else if (open && open.id === event.id) {
        // Reuse the onset reported at start: the offset EMA may have moved since, and a start/end pair that
        // disagree by a few ms would make the controller's pre-roll arithmetic non-monotonic.
        const { id, onsetMs } = open;
        open = null;
        capture.onUtteranceEnd?.({ id, onsetMs, endMs: sampleToMs(event.endSample) });
      }
      // An end with no matching start is either pre-arm speech or an utterance stop() already closed by hand.
    }
  }

  function onChunk(input: Float32Array): void {
    if (disposed) return;
    resampleInto(input);
    // Timestamp the *end* of the chunk: sample N was captured ~now, so sample 0 was captured offset ms ago.
    const measured = now() - (totalSamplesWritten * 1000) / outRate;
    offsetMs = offsetChunks < OFFSET_WARMUP_CHUNKS ? measured : offsetMs + OFFSET_ALPHA * (measured - offsetMs);
    offsetChunks++;
    drainFrames();
  }

  async function buildGraph(media: MediaStream): Promise<void> {
    teardownGraph();
    const context = new AudioContext();
    ctx = context;
    resetResampler(context.sampleRate);
    source = context.createMediaStreamSource(media);
    sink = context.createGain();
    sink.gain.value = 0; // the graph must reach the destination to be pulled; it must not be audible.

    let usedWorklet = false;
    try {
      if (context.audioWorklet) {
        if (!workletUrl) {
          workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
        }
        await context.audioWorklet.addModule(workletUrl);
        const node = new AudioWorkletNode(context, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1 });
        node.port.onmessage = (event: MessageEvent) => onChunk(new Float32Array(event.data as ArrayBuffer));
        worklet = node;
        usedWorklet = true;
      }
    } catch (err) {
      console.warn("voice: AudioWorklet unavailable, falling back to ScriptProcessor", err);
    }

    if (!usedWorklet) {
      const node = context.createScriptProcessor(CHUNK_SAMPLES, 1, 1);
      node.onaudioprocess = (event: AudioProcessingEvent) => {
        // getChannelData returns the node's own reused buffer; it must be copied before it is queued.
        onChunk(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      processor = node;
    }

    const tap: AudioNode = worklet ?? (processor as AudioNode);
    source.connect(tap);
    tap.connect(sink);
    sink.connect(context.destination);
  }

  function teardownGraph(): void {
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.disconnect();
      worklet = null;
    }
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
      processor = null;
    }
    source?.disconnect();
    source = null;
    sink?.disconnect();
    sink = null;
    if (ctx) {
      void ctx.close().catch(() => undefined);
      ctx = null;
    }
  }

  function stopStream(): void {
    stream?.getTracks().forEach(track => {
      track.onended = null;
      track.onmute = null;
      track.onunmute = null;
      track.stop();
    });
    stream = null;
    streamDeviceId = "";
  }

  function watchTrack(track: MediaStreamTrack): void {
    track.onended = () => setMic("missing", "microphone disconnected");
    track.onmute = () => setMic("error", "microphone muted");
    track.onunmute = () => setMic("ok");
  }

  /** Polls a resuming context: "ok" the moment it runs, the error only after the whole window has passed. */
  function watchResume(context: AudioContext): void {
    if (resumeTimer) clearTimeout(resumeTimer);
    const deadline = now() + RESUME_WINDOW_MS;
    const poll = (): void => {
      resumeTimer = null;
      if (disposed || ctx !== context) return;
      if (context.state === "running") {
        setMic("ok");
        return;
      }
      if (now() >= deadline) {
        setMic("error", "audio context suspended");
        return;
      }
      resumeTimer = setTimeout(poll, RESUME_POLL_MS);
    };
    resumeTimer = setTimeout(poll, RESUME_POLL_MS);
  }

  function liveTrack(): MediaStreamTrack | null {
    const track = stream?.getAudioTracks()[0];
    return track && track.readyState === "live" ? track : null;
  }

  // ---------------------------------------------------------------- public API

  async function prepare(deviceId?: string): Promise<MicState> {
    const wanted = deviceId ?? "";
    requestedDeviceId = wanted;
    if (disposed) return mic;
    const cachedCtx = ctx;
    if (stream && streamDeviceId === wanted && liveTrack() && cachedCtx) {
      // Only an "ok" cache confirms itself. Any other state would otherwise be self-sealing: a mic that errored
      // once (a mute, a slow resume) could never be re-armed for the lifetime of the page, which on the wall
      // panel means the tool is dead until someone reloads it.
      if (mic === "ok") return mic;
      if (cachedCtx.state === "running") {
        setMic("ok");
        return mic;
      }
      teardownGraph();
      stopStream();
    }
    if (preparing) return preparing;

    preparing = (async (): Promise<MicState> => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setMic("error", "no microphone API in this browser");
        return mic;
      }
      let media: MediaStream;
      let detail: string | undefined;
      try {
        media = await navigator.mediaDevices.getUserMedia(constraintsFor(wanted));
      } catch (err) {
        const name = errorName(err);
        const retryable = wanted !== "" && (name === "OverconstrainedError" || name === "NotFoundError");
        if (!retryable) {
          setMic(micStateFor(err), (err as Error | null)?.message);
          return mic;
        }
        // A saved deviceId outlives the device it named; the wall panel has no one to re-pick it, so fall back.
        try {
          media = await navigator.mediaDevices.getUserMedia(constraintsFor(""));
          detail = "fallback to default microphone";
        } catch (fallbackErr) {
          setMic(micStateFor(fallbackErr), (fallbackErr as Error | null)?.message);
          return mic;
        }
      }
      if (disposed) {
        media.getTracks().forEach(track => track.stop());
        return mic;
      }
      stopStream();
      stream = media;
      streamDeviceId = wanted;
      const track = media.getAudioTracks()[0];
      if (track) watchTrack(track);
      try {
        await buildGraph(media);
      } catch (err) {
        console.warn("voice: could not build the capture graph", err);
        setMic("error", (err as Error | null)?.message ?? "audio graph failed");
        return mic;
      }
      setMic("ok", detail);
      return mic;
    })().finally(() => {
      preparing = null;
    });
    return preparing;
  }

  async function start(): Promise<void> {
    if (disposed) return;
    if (mic !== "ok") {
      const state = await prepare(requestedDeviceId);
      if (state !== "ok") return; // the failure already went out through onMicChange
    }
    const context = ctx;
    if (context && context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        // Autoplay policy rejects resume() outside a gesture; the poll below reports it if it really stuck.
      }
      watchResume(context);
    }
    if (active) return;
    // Drops whatever the always-running VAD had open on the idle room (it keeps the measured floor), so a take
    // never inherits half an utterance: the first onset of this take is at most one onsetMs away.
    vad.reset();
    vad.setOptions({ ...vadOptions, sampleRate: outRate });
    open = null;
    levelSumSq = 0;
    levelFrames = 0;
    lastLevelAt = 0;
    active = true;
  }

  async function stop(): Promise<void> {
    if (!active) return;
    active = false;
    if (open) {
      const pending = open;
      open = null;
      capture.onUtteranceEnd?.({ id: pending.id, onsetMs: pending.onsetMs, endMs: now() });
    }
    // Not vad.reset(): the machine keeps running on the idle room so its floor stays warm for the next take.
    // The utterance it still thinks is open closes into handleVadEvents, which drops it (no matching `open`).
  }

  function wav(fromMs: number, toMs: number): Blob {
    const oldest = Math.max(0, totalSamplesWritten - capacity);
    const from = Math.min(Math.max(sampleAt(fromMs), oldest), totalSamplesWritten);
    const to = Math.min(Math.max(sampleAt(toMs), from), totalSamplesWritten);
    const out = new Float32Array(to - from);
    for (let i = 0; i < out.length; i++) out[i] = ring[(from + i) % capacity];
    return encodeWav(out, outRate);
  }

  function setVad(next: VadOptions): void {
    vadOptions = { ...vadOptions, ...next };
    vad.setOptions({ ...next, sampleRate: outRate });
  }

  function dispose(): void {
    disposed = true;
    active = false;
    open = null;
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    teardownGraph();
    stopStream();
    if (workletUrl) {
      URL.revokeObjectURL(workletUrl);
      workletUrl = null;
    }
  }

  return capture;
};

export default createVoiceCapture;
