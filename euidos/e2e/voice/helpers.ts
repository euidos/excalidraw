/**
 * Shared machinery for the voice e2e suite.
 *
 * Every test launches its OWN chromium: `--use-file-for-fake-audio-capture` is a browser-launch flag, so a
 * per-test clip is only possible with a per-test browser (the config's shared fixture browser is never used).
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { VoiceSettings, VoiceStatus } from "../../../excalidraw-app/voice/contracts";
import type { UtteranceEvent } from "../../../excalidraw-app/voice/contracts-capture";

/** Overridable so the suite can be pointed at a scratch build while diagnosing an app defect. */
export const APP_URL = process.env.VOICE_APP_URL ?? "http://127.0.0.1:4173";
export const FIXTURES = resolve("fixtures");
export const EVIDENCE = resolve("test-results/evidence");

export const fixture = (name: string): string => resolve(FIXTURES, name);

export type Pt = { x: number; y: number };

/** The element fields the assertions care about; page.evaluate can only hand back plain JSON. */
export interface SceneEl {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeStyle: string;
  strokeColor: string;
  isDeleted: boolean;
  text?: string;
  originalText?: string;
  containerId?: string | null;
  fontSize?: number;
  autoResize?: boolean;
  boundElements?: { id: string; type: string }[] | null;
  /** Region markers carry `{ voiceRegion: true }` here; see contracts.ts VOICE_REGION_CUSTOM_DATA. */
  customData?: Record<string, unknown> | null;
}

export interface Launched {
  browser: Browser;
  page: Page;
}

export interface LaunchOptions {
  /** localStorage entries written before any app code runs (G6 / R3 seed the vanilla keys this way). */
  seed?: Record<string, string>;
  /** Voice settings written before boot; merged over `warmMicOnBoot: false` (see below). */
  settings?: Partial<VoiceSettings>;
  /**
   * Launch WITHOUT `--use-fake-ui-for-media-stream` and without granting "microphone", so getUserMedia is
   * refused: the only way to exercise the denied-mic path on a real surface (N3).
   */
  denyMic?: boolean;
  /** Skip the navigation + readiness wait (unused so far, kept so a test can drive the boot itself). */
  skipGoto?: boolean;
}

/**
 * Launches chromium with the fake microphone fed by `clipPath` and opens the app.
 *
 * `warmMicOnBoot` is forced OFF for every test: Chromium starts playing the fake-audio file when getUserMedia is
 * called, so warming the mic at page load would start the clip at an unknowable offset. With it off the stream —
 * and therefore the fixture's own timeline — starts at the arm, which is what the timed tests measure from.
 *
 * Callers MUST close the browser in a finally block.
 */
export async function launchWithClip(clipPath: string, opts: LaunchOptions = {}): Promise<Launched> {
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      ...(opts.denyMic ? [] : ["--use-fake-ui-for-media-stream"]),
      `--use-file-for-fake-audio-capture=${clipPath}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    if (!opts.denyMic) {
      await context.grantPermissions(["microphone"], { origin: APP_URL });
    }
    const page = await context.newPage();
    const seed: Record<string, string> = {
      ...opts.seed,
      "voice-settings": JSON.stringify({ warmMicOnBoot: false, ...opts.settings }),
    };
    // Init scripts run on EVERY navigation, so the seed is written once: a reload must read back what the
    // app persisted, not the pristine seed again.
    await page.addInitScript((entries: Record<string, string>) => {
      if (localStorage.getItem("__e2e-seeded")) {
        return;
      }
      for (const [key, value] of Object.entries(entries)) {
        localStorage.setItem(key, value);
      }
      localStorage.setItem("__e2e-seeded", "1");
    }, seed);
    if (!opts.skipGoto) {
      await page.goto(APP_URL);
      await waitForVoiceReady(page);
    }
    return { browser, page };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/**
 * The canvas, the injected toolbar button and the debug surface are up.
 *
 * Deliberately NOT waiting for `status().mic === "ok"`: the mic is only acquired when the tool arms (the suite
 * runs with `warmMicOnBoot: false`), so mic stays "unknown" until then. armHold() waits for `recording`, which is
 * the state the tests actually depend on.
 */
export async function waitForVoiceReady(page: Page): Promise<void> {
  await page.waitForSelector(".excalidraw canvas", { timeout: 30_000 });
  await page.waitForFunction(() => !!window.__excalidrawVoice, undefined, { timeout: 30_000 });
  // The toolbar is injected by a poll after the library's own toolbar row exists; tests click it by testid.
  await page.waitForSelector('[data-testid="toolbar-voice"]', { timeout: 30_000 });
}

export const status = (page: Page): Promise<VoiceStatus> =>
  page.evaluate(() => window.__excalidrawVoice!.status());

export const settings = (page: Page): Promise<VoiceSettings> =>
  page.evaluate(() => window.__excalidrawVoice!.settings());

export const setSettings = (page: Page, patch: Partial<VoiceSettings>): Promise<void> =>
  page.evaluate((p: Partial<VoiceSettings>) => window.__excalidrawVoice!.setSettings(p), patch);

export async function elements(page: Page, includeDeleted = false): Promise<SceneEl[]> {
  return page.evaluate((withDeleted: boolean) => {
    const api = window.__excalidrawVoice!.api;
    const src = withDeleted ? api.getSceneElementsIncludingDeleted() : api.getSceneElements();
    return src.map((el) => {
      const anyEl = el as unknown as Record<string, unknown>;
      return {
        id: el.id,
        type: el.type,
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
        angle: el.angle as number,
        strokeStyle: el.strokeStyle as string,
        strokeColor: el.strokeColor,
        isDeleted: el.isDeleted,
        text: typeof anyEl.text === "string" ? (anyEl.text as string) : undefined,
        originalText: typeof anyEl.originalText === "string" ? (anyEl.originalText as string) : undefined,
        containerId: (anyEl.containerId as string | null | undefined) ?? null,
        fontSize: typeof anyEl.fontSize === "number" ? (anyEl.fontSize as number) : undefined,
        autoResize: typeof anyEl.autoResize === "boolean" ? (anyEl.autoResize as boolean) : undefined,
        boundElements: (anyEl.boundElements as { id: string; type: string }[] | null) ?? null,
        customData: (anyEl.customData as Record<string, unknown> | null | undefined) ?? null,
      };
    });
  }, includeDeleted);
}

export const texts = (els: SceneEl[]): SceneEl[] => els.filter((el) => el.type === "text");
/**
 * Live region markers: the dashed scaffolding a pending (or failed) take shows. A committed take deletes its own
 * marker, so `markers(els)` is empty for every finished region — that is the round-4a assertion.
 */
export const markers = (els: SceneEl[]): SceneEl[] =>
  els.filter((el) => !el.isDeleted && el.customData?.voiceRegion === true);
export const shapes = (els: SceneEl[], type: string): SceneEl[] => els.filter((el) => el.type === type);
/** Placeholder frames are the only single-character texts the app ever writes. */
export const isPlaceholder = (el: SceneEl): boolean => /^·{1,3}$/.test((el.text ?? "").trim());
export const transcriptTexts = (els: SceneEl[]): SceneEl[] =>
  texts(els).filter((el) => !isPlaceholder(el) && (el.text ?? "").trim().length > 0);

export interface Transform {
  zoom: number;
  offsetLeft: number;
  offsetTop: number;
  scrollX: number;
  scrollY: number;
}

export const transform = (page: Page): Promise<Transform> =>
  page.evaluate(() => {
    const s = window.__excalidrawVoice!.api.getAppState();
    return {
      zoom: s.zoom.value,
      offsetLeft: s.offsetLeft,
      offsetTop: s.offsetTop,
      scrollX: s.scrollX,
      scrollY: s.scrollY,
    };
  });

/** Client (viewport) → scene, matching the library's own viewportCoordsToSceneCoords. */
export const toScene = (t: Transform, p: Pt): Pt => ({
  x: (p.x - t.offsetLeft) / t.zoom - t.scrollX,
  y: (p.y - t.offsetTop) / t.zoom - t.scrollY,
});

export const bbox = (pts: Pt[]) => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

export const sceneBBox = (t: Transform, pts: Pt[]) => bbox(pts.map((p) => toScene(t, p)));

// --- pointer input -------------------------------------------------------

export interface StrokeTiming {
  /** ms between pointer samples. */
  stepMs?: number;
  /** Wait before pointer-down. 0 makes `mouse.up` → `mouse.down` of the next stroke a zero-gap pair (N2a). */
  leadMs?: number;
  /** Wait after pointer-up. The controller reads the finished element a tick + a frame later; 0 does not wait. */
  settleMs?: number;
}

/**
 * Excalidraw throttles its drag handler with requestAnimationFrame, so a synchronous `mouse.move(...,{steps})`
 * collapses to a single point. Every step therefore gets its own frame.
 *
 * The settle wait is a parameter, not a constant: round 1 slept 120 ms after every pointer-up and thereby hid the
 * capture race the zero-gap and disarm-in-window cases exist to hit (RETRO L3).
 */
export async function drawStroke(page: Page, pts: Pt[], timing: StrokeTiming = {}): Promise<void> {
  const stepMs = timing.stepMs ?? 24;
  const leadMs = timing.leadMs ?? stepMs;
  const settleMs = timing.settleMs ?? 120;
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  if (leadMs > 0) {
    await page.waitForTimeout(leadMs);
  }
  await page.mouse.down();
  await page.waitForTimeout(stepMs);
  for (const p of pts.slice(1)) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(stepMs);
  }
  await page.mouse.up();
  if (settleMs > 0) {
    await page.waitForTimeout(settleMs);
  }
}

/** A palm contact / stylus jitter: a few screen px, no dwell. Must never become a shape. */
export async function tap(page: Page, at: Pt, px = 3): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + px, at.y + Math.round(px / 2));
  await page.mouse.up();
}

export const ellipsePath = (cx: number, cy: number, rx: number, ry: number, steps = 28): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    pts.push({ x: Math.round(cx + rx * Math.cos(a)), y: Math.round(cy + ry * Math.sin(a)) });
  }
  return pts;
};

export const linePath = (from: Pt, to: Pt, steps = 16): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) {
    pts.push({
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps),
    });
  }
  return pts;
};

/**
 * Holds F9 and waits until capture is actually running. Returns the wall clock of the key press: with
 * `warmMicOnBoot` off that is also when getUserMedia is called, which is when Chromium starts playing the
 * fake-audio file — so a fixture's own timeline can be scheduled from it (see waitUntilWall).
 */
export async function armHold(page: Page): Promise<number> {
  const t0 = Date.now();
  await page.keyboard.down("F9");
  await page.waitForFunction(() => window.__excalidrawVoice!.status().recording === true, undefined, {
    timeout: 15_000,
  });
  return t0;
}

export async function releaseHold(page: Page): Promise<void> {
  await page.keyboard.up("F9");
}

/** The capture clock (contracts-capture `VoiceCapture.now`) — the clock utterance onsets are stamped with. */
export const captureNow = (page: Page): Promise<number> =>
  page.evaluate(() => window.__excalidrawVoice!.capture!.now());

/** Waits until the capture clock passes `ms`. Timings that must beat the pre-roll are expressed in this clock. */
export async function waitCaptureUntil(page: Page, ms: number): Promise<void> {
  for (;;) {
    const now = await captureNow(page);
    if (now >= ms) {
      return;
    }
    await page.waitForTimeout(Math.min(250, Math.max(10, ms - now)));
  }
}

/** Wall-clock scheduling relative to the F9 press, which is also when the fixture starts playing. */
export async function waitUntilWall(page: Page, t0: number, ms: number): Promise<void> {
  const left = t0 + ms - Date.now();
  if (left > 0) {
    await page.waitForTimeout(left);
  }
}

export interface SeenUtterance extends UtteranceEvent {
  /** capture-clock ms at which the event was delivered. */
  at: number;
}

/**
 * Chains a recorder onto the capture module's utterance callbacks (the controller assigned its own at
 * construction and this wrapper calls it), so a test can schedule against real VAD boundaries instead of
 * guessing where the speech in a clip lands.
 */
export async function recordUtterances(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bucket: SeenUtterance[] = [];
    (window as unknown as { __utterances: SeenUtterance[] }).__utterances = bucket;
    const capture = window.__excalidrawVoice!.capture!;
    const priorStart = capture.onUtteranceStart;
    const priorEnd = capture.onUtteranceEnd;
    capture.onUtteranceStart = (u) => {
      bucket.push({ id: u.id, onsetMs: u.onsetMs, at: capture.now() });
      priorStart?.(u);
    };
    capture.onUtteranceEnd = (u) => {
      const seen = bucket.find((e) => e.id === u.id);
      if (seen) {
        seen.endMs = u.endMs;
      }
      priorEnd?.(u);
    };
  });
}

export const seenUtterances = (page: Page): Promise<SeenUtterance[]> =>
  page.evaluate(() => (window as unknown as { __utterances: SeenUtterance[] }).__utterances ?? []);

/** Resolves with the (1-based) nth utterance once its onset is known; `recordUtterances` must have run first. */
export async function waitForUtterance(page: Page, nth: number, timeoutMs = 20_000): Promise<SeenUtterance> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await seenUtterances(page);
    if (seen.length >= nth) {
      return seen[nth - 1]!;
    }
    if (Date.now() > deadline) {
      throw new Error(`no utterance #${nth} within ${timeoutMs} ms (saw ${seen.length})`);
    }
    await page.waitForTimeout(100);
  }
}

// --- the mic glyph ------------------------------------------------------

/** What the toolbar button is currently showing (round 4b: the glyph itself is the level meter). */
export interface MicGlyph {
  armed: boolean;
  /** The VAD has an open utterance: the accent colour. */
  speaking: boolean;
  /** `--voice-level`, 0..1 — how full the mic capsule is drawn. */
  level: number;
}

const GLYPH_SELECTOR = '[data-testid="toolbar-voice"]';

export const micGlyph = (page: Page): Promise<MicGlyph> =>
  page.evaluate((selector: string) => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) {
      throw new Error("voice button not in the DOM");
    }
    const raw = Number.parseFloat(el.style.getPropertyValue("--voice-level"));
    return {
      armed: el.classList.contains("voice-tool--armed"),
      speaking: el.classList.contains("voice-tool--speaking"),
      level: Number.isFinite(raw) ? raw : 0,
    };
  }, GLYPH_SELECTOR);

interface GlyphWatch {
  peakLevel: number;
  sawSpeaking: boolean;
  samples: number;
  /** Every level the glyph was drawn at, so a gate can ask whether it REACTED or just toggled (round 4c). */
  levels: number[];
}

/**
 * Samples the glyph every 30 ms from inside the page.
 *
 * Polling from the test runner cannot see this: an utterance in a 2 s fixture is open for ~2 s and the capsule only
 * fills while the speech is actually loud, so a round trip per sample would miss the peak and the accent both.
 */
export async function watchMicGlyph(page: Page): Promise<void> {
  await page.evaluate((selector: string) => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) {
      throw new Error("voice button not in the DOM");
    }
    const watch: GlyphWatch = { peakLevel: 0, sawSpeaking: false, samples: 0, levels: [] };
    const w = window as unknown as { __glyphWatch: GlyphWatch; __glyphWatchStop?: () => void };
    w.__glyphWatch = watch;
    const timer = setInterval(() => {
      watch.samples += 1;
      const raw = Number.parseFloat(el.style.getPropertyValue("--voice-level"));
      if (Number.isFinite(raw)) {
        watch.peakLevel = Math.max(watch.peakLevel, raw);
        if (watch.levels.length < 1000) {
          watch.levels.push(raw);
        }
      }
      if (el.classList.contains("voice-tool--speaking")) {
        watch.sawSpeaking = true;
      }
    }, 30);
    w.__glyphWatchStop = () => clearInterval(timer);
  }, GLYPH_SELECTOR);
}

/** Highest level and whether the accent ever appeared since watchMicGlyph(); stops the sampler. */
export const readMicGlyphWatch = (page: Page): Promise<GlyphWatch> =>
  page.evaluate(() => {
    const w = window as unknown as { __glyphWatch?: GlyphWatch; __glyphWatchStop?: () => void };
    w.__glyphWatchStop?.();
    return w.__glyphWatch ?? { peakLevel: 0, sawSpeaking: false, samples: 0, levels: [] };
  });

// --- round 5: when the words appear ---------------------------------------

/** One observation of a text the app wrote: an interim preview, or the committed transcript. */
export interface WordsSample {
  /** `Date.now()` inside the page, the same clock `upAt` is stamped with. */
  at: number;
  text: string;
  opacity: number;
  /** `status.speaking` at that instant: the VAD still has the utterance open. */
  speaking: boolean;
  /** `capture.now()` — the clock utterance onsets and ends are stamped with. */
  captureNow: number;
}
export interface WordsWatch {
  /** `Date.now()` of the pointer-up that finished the region, taken inside the page. */
  upAt: number;
  /** First interim-stamped text to appear. */
  interim: WordsSample | null;
  /** First committed (unstamped, non-placeholder) transcript to appear. */
  committed: WordsSample | null;
  samples: number;
}

/**
 * Samples the scene from INSIDE the page every 10 ms and records when the words first appear.
 *
 * The measurement round 5 is about is "pen-up → words on the canvas", and polling that from the test runner adds a
 * CDP round trip to every sample — on the same order as the number being measured. Both timestamps therefore come
 * from the page's own clock: `upAt` from a capture-phase `pointerup` listener on window (Excalidraw's canvas events
 * bubble there), `committed.at` from the sampler.
 */
export async function watchWords(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __wordsWatch: WordsWatch; __wordsWatchStop?: () => void };
    const watch: WordsWatch = { upAt: 0, interim: null, committed: null, samples: 0 };
    w.__wordsWatch = watch;
    const onUp = (): void => {
      if (!watch.upAt) {
        watch.upAt = Date.now();
      }
    };
    window.addEventListener("pointerup", onUp, true);
    const isDots = (t: string): boolean => /^\u00b7{1,3}$/.test(t.trim());
    const timer = setInterval(() => {
      watch.samples += 1;
      const voice = window.__excalidrawVoice!;
      const sample = (el: { text?: string; opacity?: number }): WordsSample => ({
        at: Date.now(),
        text: String(el.text ?? "").trim(),
        opacity: Number(el.opacity ?? 100),
        speaking: voice.status().speaking,
        captureNow: voice.capture ? voice.capture.now() : 0,
      });
      for (const el of voice.api.getSceneElements()) {
        const anyEl = el as unknown as {
          type: string;
          text?: string;
          opacity?: number;
          customData?: Record<string, unknown> | null;
        };
        if (anyEl.type !== "text" || typeof anyEl.text !== "string") {
          continue;
        }
        const t = anyEl.text.trim();
        if (!t || isDots(t) || t.startsWith("\u26a0")) {
          continue;
        }
        if (anyEl.customData?.voiceInterim === true) {
          watch.interim ??= sample(anyEl);
          continue;
        }
        watch.committed ??= sample(anyEl);
      }
    }, 10);
    w.__wordsWatchStop = () => {
      clearInterval(timer);
      window.removeEventListener("pointerup", onUp, true);
    };
  });
}

/** Reads the sampler without stopping it, so a gate can poll for the commit it is waiting for. */
export const readWords = (page: Page): Promise<WordsWatch> =>
  page.evaluate(
    () =>
      (window as unknown as { __wordsWatch?: WordsWatch }).__wordsWatch ?? {
        upAt: 0,
        interim: null,
        committed: null,
        samples: 0,
      },
  );

export const stopWords = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as { __wordsWatchStop?: () => void }).__wordsWatchStop?.();
  });

export async function evidence(page: Page, name: string): Promise<string> {
  mkdirSync(EVIDENCE, { recursive: true });
  const path = resolve(EVIDENCE, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

// --- fixtures ------------------------------------------------------------

interface Wav {
  rate: number;
  channels: number;
  bits: number;
  data: Buffer;
}

function writeWav(path: string, wav: Wav): void {
  const header = Buffer.alloc(44);
  const byteRate = (wav.rate * wav.channels * wav.bits) / 8;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + wav.data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(wav.channels, 22);
  header.writeUInt32LE(wav.rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((wav.channels * wav.bits) / 8, 32);
  header.writeUInt16LE(wav.bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(wav.data.length, 40);
  writeFileSync(path, Buffer.concat([header, wav.data]));
}

/** 2 s of digital silence, 16 kHz mono 16-bit — the "empty transcript" fixture. */
export function ensureSilenceClip(): string {
  const path = fixture("silence.wav");
  if (!existsSync(path)) {
    writeWav(path, { rate: 16_000, channels: 1, bits: 16, data: Buffer.alloc(16_000 * 2 * 2) });
  }
  return path;
}

/** The PCM of a 16-bit mono WAV, found by walking the chunks (jfk.wav carries a LIST chunk before its data). */
function pcmOf(path: string): { rate: number; data: Buffer } {
  const src = readFileSync(path);
  const rate = src.readUInt32LE(24);
  let at = 12;
  while (at + 8 <= src.length) {
    const id = src.subarray(at, at + 4).toString("latin1");
    const size = src.readUInt32LE(at + 4);
    if (id === "data") {
      return { rate, data: src.subarray(at + 8, at + 8 + size) };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

/**
 * A copy of `name` with `leadMs` of silence in front, written under test-results/ (generated, git-ignored).
 *
 * Why any gate needs this: the VAD seeds the room's noise floor from the first ~200 ms of audio it ever sees, and
 * the effective threshold is max(setting, 3 × floor) — so a clip that starts ON a loud syllable seeds the floor at
 * speech level and the VAD stays deaf until it decays (measured: ~4.5 s of ko-long swallowed, one 0.5 s utterance
 * out of 5.4 s of speech). Chromium starts playing the file when the stream opens, i.e. at the arm, so a fixture
 * whose speech starts at 120 ms is exactly that case. A gate that needs a LONG OPEN utterance (round 5's interim
 * preview) therefore hands the VAD a second of silence first — which is also what a real room gives it.
 */
export function ensureLeadInClip(name: string, leadMs = 1200): string {
  const out = resolve("test-results/fixtures", `${name.replace(/\.wav$/, "")}-lead${leadMs}.wav`);
  if (!existsSync(out)) {
    const { rate, data } = pcmOf(fixture(name));
    const lead = Buffer.alloc(Math.round((rate * leadMs) / 1000) * 2);
    mkdirSync(resolve("test-results/fixtures"), { recursive: true });
    writeWav(out, { rate, channels: 1, bits: 16, data: Buffer.concat([lead, data]) });
  }
  return out;
}
