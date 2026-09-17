/**
 * Shared machinery for the voice e2e suite.
 *
 * Every test launches its OWN chromium: `--use-file-for-fake-audio-capture` is a browser-launch flag, so a
 * per-test clip is only possible with a per-test browser (the config's shared fixture browser is never used).
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { VoiceSettings, VoiceStatus } from "../../src/contracts";

/** Overridable so the suite can be pointed at a scratch build while diagnosing an app defect. */
export const APP_URL = process.env.VOICE_APP_URL ?? "http://127.0.0.1:4173";
export const FIXTURES = resolve("test/fixtures");
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
  containerId?: string | null;
  fontSize?: number;
  boundElements?: { id: string; type: string }[] | null;
}

export interface Launched {
  browser: Browser;
  page: Page;
}

export interface LaunchOptions {
  /** localStorage entries written before any app code runs (G6 seeds the vanilla keys this way). */
  seed?: Record<string, string>;
  /** Skip the navigation + readiness wait (unused so far, kept so a test can drive the boot itself). */
  skipGoto?: boolean;
}

/**
 * Launches chromium with the fake microphone fed by `clipPath` and opens the app.
 * Callers MUST close the browser in a finally block.
 */
export async function launchWithClip(clipPath: string, opts: LaunchOptions = {}): Promise<Launched> {
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${clipPath}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.grantPermissions(["microphone"], { origin: APP_URL });
    const page = await context.newPage();
    if (opts.seed) {
      const seed = opts.seed;
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
    }
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
 * The canvas and the debug surface are up.
 *
 * Deliberately NOT waiting for `status().mic === "ok"`: getStatus() hands back the last emitted snapshot and
 * recorder.prepare() resolving does not emit, so mic stays "unknown" until the first arm. armHold() waits for
 * `recording` instead, which is the state the tests actually depend on.
 */
export async function waitForVoiceReady(page: Page): Promise<void> {
  await page.waitForSelector(".excalidraw canvas", { timeout: 30_000 });
  await page.waitForFunction(() => !!window.__excalidrawVoice, undefined, { timeout: 30_000 });
  // getUserMedia is kicked off on mount; give it a moment so the first hold records from the clip's start.
  await page.waitForTimeout(500);
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
        containerId: (anyEl.containerId as string | null | undefined) ?? null,
        fontSize: typeof anyEl.fontSize === "number" ? (anyEl.fontSize as number) : undefined,
        boundElements: (anyEl.boundElements as { id: string; type: string }[] | null) ?? null,
      };
    });
  }, includeDeleted);
}

export const texts = (els: SceneEl[]): SceneEl[] => els.filter((el) => el.type === "text");
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

/**
 * Excalidraw throttles its drag handler with requestAnimationFrame, so a synchronous `mouse.move(...,{steps})`
 * collapses to a single point. Every step therefore gets its own frame.
 */
export async function drawStroke(page: Page, pts: Pt[], stepMs = 24): Promise<void> {
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.waitForTimeout(stepMs);
  await page.mouse.down();
  await page.waitForTimeout(stepMs);
  for (const p of pts.slice(1)) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(stepMs);
  }
  await page.waitForTimeout(stepMs);
  await page.mouse.up();
  // The controller reads the finished element a tick + a frame after pointer-up.
  await page.waitForTimeout(120);
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

/** Holds F9 and waits until the recorder is actually running, so the first stroke is never dropped. */
export async function armHold(page: Page): Promise<void> {
  await page.keyboard.down("F9");
  await page.waitForFunction(() => window.__excalidrawVoice!.status().recording === true, undefined, {
    timeout: 15_000,
  });
}

export async function releaseHold(page: Page): Promise<void> {
  await page.keyboard.up("F9");
}

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

function readWav(path: string): Wav {
  const buf = readFileSync(path);
  let offset = 12; // past "RIFF....WAVE"
  let rate = 16_000;
  let channels = 1;
  let bits = 16;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === "fmt ") {
      channels = body.readUInt16LE(2);
      rate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
    } else if (id === "data") {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }
  if (!data) {
    throw new Error(`no data chunk in ${path}`);
  }
  return { rate, channels, bits, data };
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

/**
 * jfk.wav with its inter-sentence pauses cut down to 150 ms.
 *
 * G2 assigns ~1.2 s of the LOOPING clip to each shape, and raw jfk.wav has a 1.2 s pause in it: a segment that
 * happened to land on that pause would transcribe as "" and the app would (correctly) drop its placeholder,
 * failing the gate for a reason that has nothing to do with parallelism. Densifying keeps the audio real speech
 * from the same speaker while making every 1.2 s window carry words.
 */
export function ensureDenseClip(): string {
  const path = fixture("jfk-dense.wav");
  if (existsSync(path)) {
    return path;
  }
  const src = readWav(fixture("jfk.wav"));
  const samples = new Int16Array(src.data.buffer, src.data.byteOffset, src.data.length / 2);
  const frame = Math.round(src.rate * 0.02);
  const keepPause = Math.round(src.rate * 0.15);
  const loud: boolean[] = [];
  for (let i = 0; i < samples.length; i += frame) {
    let sum = 0;
    const end = Math.min(samples.length, i + frame);
    for (let j = i; j < end; j += 1) {
      sum += samples[j]! * samples[j]!;
    }
    loud.push(Math.sqrt(sum / Math.max(1, end - i)) / 32_768 > 0.02);
  }
  const out: number[] = [];
  let pause = 0;
  for (let f = 0; f < loud.length; f += 1) {
    const start = f * frame;
    const end = Math.min(samples.length, start + frame);
    // Keep a frame when it is loud or within one frame of speech; otherwise let at most keepPause of quiet through.
    const near = loud[f] || loud[f - 1] === true || loud[f + 1] === true;
    if (near) {
      pause = 0;
    } else {
      pause += end - start;
      if (pause > keepPause) {
        continue;
      }
    }
    for (let j = start; j < end; j += 1) {
      out.push(samples[j]!);
    }
  }
  const data = Buffer.alloc(out.length * 2);
  for (let i = 0; i < out.length; i += 1) {
    data.writeInt16LE(out[i]!, i * 2);
  }
  writeWav(path, { rate: src.rate, channels: src.channels, bits: 16, data });
  return path;
}
