/**
 * audio.ts — one MediaRecorder per segment on a long-lived MediaStream.
 *
 * The stream is acquired once and kept for the whole session: getUserMedia costs hundreds of ms on the
 * whiteboard, which would swallow the beginning of every utterance if it ran per segment.
 */
import type {
  CreateSegmentRecorder,
  MicState,
  RecorderOptions,
  SegmentRecorder,
} from "./contracts";

const DEFAULT_MIN_DURATION_MS = 300;
const LEVEL_INTERVAL_MS = 100;
/** getFloatTimeDomainData RMS of speech sits around 0.05..0.25; ×4 maps that onto a usable 0..1 meter. */
const LEVEL_GAIN = 4;

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

/** One in-flight segment: its recorder, its chunks and the promise that settles when the recorder stops. */
interface Segment {
  rec: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  blob: Promise<Blob | null>;
}

function pickMimeType(preferred?: string): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = preferred ? [preferred, ...MIME_CANDIDATES] : MIME_CANDIDATES;
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // isTypeSupported throws on some engines for malformed types; just try the next one.
    }
  }
  return undefined;
}

function mapMicError(err: unknown): MicState {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "missing";
  return "error";
}

export const createSegmentRecorder: CreateSegmentRecorder = (opts?: RecorderOptions): SegmentRecorder => {
  const minDurationMs = opts?.minDurationMs ?? DEFAULT_MIN_DURATION_MS;

  let stream: MediaStream | null = null;
  let streamDeviceId = "";
  let mimeType: string | undefined;
  let current: Segment | null = null;
  let recording = false;
  let mic: MicState = "unknown";

  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let levelBuf: Float32Array<ArrayBuffer> | null = null;
  let levelTimer: ReturnType<typeof setInterval> | null = null;

  const self: SegmentRecorder = {
    get recording() {
      return recording;
    },
    get mic() {
      return mic;
    },
    prepare,
    start,
    cut,
    stop,
    dispose,
  };

  function streamUsable(deviceId: string): boolean {
    if (!stream || streamDeviceId !== deviceId) return false;
    return stream.getAudioTracks().some((t) => t.readyState === "live");
  }

  function teardownMeter() {
    if (levelTimer !== null) {
      clearInterval(levelTimer);
      levelTimer = null;
    }
    try {
      sourceNode?.disconnect();
    } catch {
      // node may already be detached with its context
    }
    sourceNode = null;
    analyser = null;
    levelBuf = null;
    if (audioCtx) {
      void audioCtx.close().catch(() => undefined);
      audioCtx = null;
    }
  }

  function setupMeter(src: MediaStream) {
    teardownMeter();
    const Ctor: typeof AudioContext | undefined =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      audioCtx = new Ctor();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      sourceNode = audioCtx.createMediaStreamSource(src);
      sourceNode.connect(analyser);
      levelBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    } catch (err) {
      console.warn("[voice] level meter unavailable", err);
      audioCtx = null;
      analyser = null;
      levelBuf = null;
    }
  }

  function startMeter() {
    if (!analyser || !levelBuf || levelTimer !== null) return;
    levelTimer = setInterval(() => {
      const node = analyser;
      const buf = levelBuf;
      if (!node || !buf || !self.onLevel) return;
      node.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length) * LEVEL_GAIN;
      self.onLevel(Math.min(1, Math.max(0, rms)));
    }, LEVEL_INTERVAL_MS);
  }

  function stopMeter() {
    if (levelTimer !== null) {
      clearInterval(levelTimer);
      levelTimer = null;
    }
    self.onLevel?.(0);
  }

  async function prepare(deviceId?: string): Promise<MicState> {
    const wanted = deviceId ?? "";
    if (streamUsable(wanted)) {
      mic = "ok";
      return mic;
    }
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) {
      mic = "missing";
      return mic;
    }
    const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
    const audio: MediaTrackConstraints = wanted ? { deviceId: { exact: wanted }, ...base } : base;
    try {
      const next = await md.getUserMedia({ audio });
      releaseStream();
      stream = next;
      streamDeviceId = wanted;
      mimeType = pickMimeType(opts?.mimeType);
      setupMeter(next);
      mic = "ok";
    } catch (err) {
      mic = mapMicError(err);
      console.warn("[voice] microphone unavailable", err);
    }
    return mic;
  }

  function releaseStream() {
    stream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // track already ended
      }
    });
    stream = null;
  }

  /** Builds a recorder plus the promise for its finished blob, and starts it (no timeslice: one blob per segment). */
  function openSegment(src: MediaStream): Segment {
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(src, mimeType ? { mimeType } : undefined);
    const startedAt = performance.now();
    const blob = new Promise<Blob | null>((resolve) => {
      rec.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        const durationMs = performance.now() - startedAt;
        const out = new Blob(chunks, { type: mimeType ?? chunks[0]?.type ?? "audio/webm" });
        resolve(durationMs < minDurationMs || out.size === 0 ? null : out);
      };
      rec.onerror = (e) => {
        console.warn("[voice] recorder error", e);
        resolve(null);
      };
    });
    rec.start();
    return { rec, chunks, startedAt, blob };
  }

  async function start(): Promise<void> {
    if (recording) return;
    if (!streamUsable(streamDeviceId)) await prepare(streamDeviceId);
    if (!stream || mic !== "ok") return;
    if (typeof MediaRecorder === "undefined") {
      mic = "error";
      console.warn("[voice] MediaRecorder unsupported");
      return;
    }
    // The context is created before any user gesture, so it usually starts suspended.
    if (audioCtx?.state === "suspended") await audioCtx.resume().catch(() => undefined);
    try {
      current = openSegment(stream);
      recording = true;
      startMeter();
    } catch (err) {
      console.warn("[voice] could not start recording", err);
      current = null;
      recording = false;
      mic = "error";
    }
  }

  /** Stops `seg` and yields its blob; never rejects. */
  async function closeSegment(seg: Segment): Promise<Blob | null> {
    try {
      if (seg.rec.state !== "inactive") seg.rec.stop();
      return await seg.blob;
    } catch (err) {
      console.warn("[voice] segment failed", err);
      return null;
    }
  }

  async function cut(): Promise<Blob | null> {
    const prev = current;
    if (!prev || !stream) return null;
    // Open the next segment BEFORE stopping the old one so the gap in the audio is a frame, not a round trip.
    try {
      current = openSegment(stream);
      recording = true;
    } catch (err) {
      console.warn("[voice] could not open next segment", err);
      current = null;
      recording = false;
      stopMeter();
    }
    return closeSegment(prev);
  }

  async function stop(): Promise<Blob | null> {
    const seg = current;
    current = null;
    recording = false;
    stopMeter();
    if (!seg) return null;
    return closeSegment(seg);
  }

  function dispose(): void {
    const seg = current;
    current = null;
    recording = false;
    stopMeter();
    if (seg) {
      try {
        if (seg.rec.state !== "inactive") seg.rec.stop();
      } catch {
        // recorder already torn down
      }
    }
    teardownMeter();
    releaseStream();
    streamDeviceId = "";
    mic = "unknown";
  }

  return self;
};

export default createSegmentRecorder;
