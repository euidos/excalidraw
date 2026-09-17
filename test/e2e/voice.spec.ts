/**
 * Real-surface proof for the voice tool: a real browser, Chromium's fake microphone fed with real speech WAVs,
 * and the founder's real STT server. Nothing here is mocked, so every assertion is about the shipped bundle.
 *
 * Round 2 drives the PCM-capture model (capture.ts + assign.ts): an utterance is a speech burst bounded by VAD
 * silence and it belongs to the LATEST stroke whose pointer-down is no later than its onset + pre-roll. Two
 * consequences shape every timed case below:
 *   - a clip with silence in it is the fixture, not a looping sentence — the silence is what cuts utterances;
 *   - "wait 600 ms between strokes" is not a timing detail any more, it decides WHO gets the words, so the timed
 *     cases schedule against the capture clock and against the VAD's own utterance events (helpers.recordUtterances).
 * `warmMicOnBoot` is off for the whole suite (helpers.launchWithClip), so the fixture starts playing at the F9
 * press and t0 is a real reference point.
 *
 * One browser per test (the clip is a launch flag) and one screenshot per gate under test-results/evidence/.
 */
import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_SETTINGS, type StyleSnapshot } from "../../src/contracts";
import {
  armHold,
  drawStroke,
  elements,
  ellipsePath,
  ensureSilenceClip,
  evidence,
  fixture,
  isPlaceholder,
  launchWithClip,
  linePath,
  releaseHold,
  sceneBBox,
  seenUtterances,
  recordUtterances,
  setSettings,
  shapes,
  status,
  tap,
  texts,
  transcriptTexts,
  transform,
  waitCaptureUntil,
  waitForUtterance,
  waitForVoiceReady,
  waitUntilWall,
  type Pt,
  type SceneEl,
} from "./helpers";

const STT_URL = "http://100.81.33.83:8770";
const PRE_ROLL_MS = DEFAULT_SETTINGS.preRollMs;

const THREE = `${fixture("three-utterances.wav")}%noloop`;
const EN_SHORT = `${fixture("en-short.wav")}%noloop`;

/** "⚠ STT" is a transcript-shaped text that is not a transcript; keep it out of the transcript assertions. */
const finalTexts = (els: SceneEl[]): SceneEl[] =>
  transcriptTexts(els).filter((el) => !(el.text ?? "").includes("STT"));
/** Committed text is WRAPPED text: "fellow\nAmericans" is the same sentence, so word assertions read it flat. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
const joined = (els: SceneEl[]): string => finalTexts(els).map((el) => flat(el.text ?? "")).join(" | ");
const boundText = (els: SceneEl[], containerId: string): string =>
  flat(finalTexts(els).find((el) => el.containerId === containerId)?.text ?? "");

const centerOf = (el: SceneEl): Pt => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });
/** The timed cases run at zoom 1 with no scroll, so a screen centre and a scene centre are the same point. */
const nearest = (els: SceneEl[], type: string, at: Pt): SceneEl | undefined =>
  shapes(els, type)
    .slice()
    .sort((a, b) => Math.hypot(centerOf(a).x - at.x, centerOf(a).y - at.y) - Math.hypot(centerOf(b).x - at.x, centerOf(b).y - at.y))[0];

/** An oval stroke ~300x160 screen px, cheap enough to draw inside a two-second window. */
const oval = (at: Pt, steps = 12): Pt[] => ellipsePath(at.x, at.y, 150, 80, steps);

/** The three shapes of the N6 cases, in the order they are drawn. */
const N6_SPOTS: Pt[] = [
  { x: 380, y: 240 },
  { x: 1060, y: 240 },
  { x: 700, y: 640 },
];

/**
 * Waits for the take to be fully resolved. `pending === 0` alone is NOT that state: between the last stroke and
 * the VAD closing the last utterance nothing is in flight either, so a poll on pending alone passes before the
 * transcript was ever requested. `completed` is what only moves when a transcript actually lands.
 */
const settled = async (page: Page, utterances: number, completed = utterances): Promise<void> => {
  await expect
    .poll(async () => {
      const s = await status(page);
      return `utterances=${s.utterances} completed>=${completed}:${s.completed >= completed} pending=${s.pending}`;
    }, { timeout: 60_000 })
    .toBe(`utterances=${utterances} completed>=${completed}:true pending=0`);
};

/**
 * The three-utterance fixture asserts WORDS, so a stroke holding another stroke's words is a failure even when
 * every count is right (RETRO L1: the round-1 gates could not see a misassignment).
 */
async function assertThreeUtteranceWords(page: Page): Promise<SceneEl[]> {
  const els = await elements(page);
  const ellipses = shapes(els, "ellipse");
  expect(ellipses.length, "one shape per stroke").toBe(3);
  const found = N6_SPOTS.map((spot) => nearest(els, "ellipse", spot)!);
  expect(new Set(found.map((el) => el.id)).size, "each stroke found its own shape").toBe(3);
  const spoken = found.map((el) => boundText(els, el.id));

  expect(spoken[0], `shape 1 (${spoken.join(" | ")})`).toMatch(/회의/);
  expect(spoken[1], `shape 2 (${spoken.join(" | ")})`).toMatch(/voice/i);
  expect(spoken[2], `shape 3 (${spoken.join(" | ")})`).toMatch(/화이트보드|목표/);
  expect(spoken[0], "shape 1 kept its neighbours' words out").not.toMatch(/voice|화이트보드|목표/i);
  expect(spoken[1], "shape 2 kept its neighbours' words out").not.toMatch(/회의|화이트보드|목표/);
  expect(spoken[2], "shape 3 kept its neighbours' words out").not.toMatch(/회의|voice/i);
  return els;
}

test.describe("voice areas", () => {
  test("G1 vertical slice: one stroke + speech becomes a filled ellipse", async () => {
    const { browser, page } = await launchWithClip(fixture("jfk.wav"));
    try {
      const view = await transform(page);
      const path = ellipsePath(700, 450, 150, 80, 32);
      const expected = sceneBBox(view, path);

      const t0 = await armHold(page);
      await drawStroke(page, path, { stepMs: 16 });
      await expect
        .poll(async () => shapes(await elements(page), "ellipse").length, { timeout: 15_000 })
        .toBe(1);
      // The clip starts at the arm, so "And so, my fellow Americans," is the first utterance; 6 s covers it and
      // the VAD silence that closes it.
      await waitUntilWall(page, t0, 6_000);
      await releaseHold(page);

      await expect
        .poll(async () => joined(await elements(page)), { timeout: 30_000 })
        .toMatch(/fellow americans/i);

      const els = await elements(page);
      const ellipse = shapes(els, "ellipse")[0]!;
      const text = finalTexts(els)[0]!;
      expect(text.containerId).toBe(ellipse.id);
      expect(ellipse.strokeStyle).toBe("solid");
      expect(Math.abs(ellipse.width - expected.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(ellipse.height - expected.height)).toBeLessThanOrEqual(2);
      expect(Math.abs(ellipse.x - expected.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(ellipse.y - expected.y)).toBeLessThanOrEqual(2);
      await evidence(page, "g1-vertical-slice");
    } finally {
      await browser.close();
    }
  });

  test("G2 parallelism: three strokes in one hold, each keeps the speech that follows it", async () => {
    const { browser, page } = await launchWithClip(fixture("jfk.wav"));
    try {
      await recordUtterances(page);
      const spots: Pt[] = [
        { x: 450, y: 260 },
        { x: 950, y: 260 },
        { x: 700, y: 620 },
      ];
      await armHold(page);

      // Each stroke is drawn once the previous utterance can no longer change owner (onset + pre-roll), so the
      // three shapes genuinely divide the same continuous speech instead of the last stroke sweeping it up.
      await drawStroke(page, oval(spots[0]!), { stepMs: 14 });
      for (const spot of spots.slice(1)) {
        const seen = await seenUtterances(page);
        const last = seen[seen.length - 1]!;
        await waitCaptureUntil(page, last.onsetMs + PRE_ROLL_MS + 250);
        const before = (await seenUtterances(page)).length;
        await drawStroke(page, oval(spot), { stepMs: 14 });
        await waitForUtterance(page, before + 1);
      }

      // Still armed, still recording: the first two shapes already carry their transcripts while the third is
      // being spoken — no stroke waited for a transcript.
      const during = await elements(page);
      expect(shapes(during, "ellipse").length, "three shapes coexist").toBe(3);
      expect(
        finalTexts(during).length,
        "an earlier stroke committed while the hold continues",
      ).toBeGreaterThanOrEqual(1);
      expect((await status(page)).mode).toBe("holding");

      const seen = await seenUtterances(page);
      await waitCaptureUntil(page, seen[seen.length - 1]!.onsetMs + 2_500);
      await releaseHold(page);

      await expect.poll(async () => (await status(page)).completed, { timeout: 40_000 }).toBeGreaterThanOrEqual(3);
      await expect.poll(async () => (await status(page)).pending, { timeout: 40_000 }).toBe(0);

      const els = await elements(page);
      const ellipses = shapes(els, "ellipse");
      expect(ellipses.length).toBe(3);
      for (const spot of spots) {
        const shape = nearest(els, "ellipse", spot)!;
        expect(boundText(els, shape.id).trim().length, `shape at ${spot.x},${spot.y}`).toBeGreaterThan(0);
      }
      expect((await status(page)).orphans).toBe(0);
      await evidence(page, "g2-parallelism");
    } finally {
      await browser.close();
    }
  });

  test("G3 recognition: the shipped bundle recognises the same shapes as the unit tests", async () => {
    const { browser, page } = await launchWithClip(ensureSilenceClip());
    try {
      const result = await page.evaluate(() => {
        const recognize = window.__excalidrawVoice!.recognize;
        const circle: { x: number; y: number }[] = [];
        for (let i = 0; i <= 32; i += 1) {
          const a = (i / 32) * Math.PI * 2;
          circle.push({ x: 400 + 120 * Math.cos(a), y: 300 + 90 * Math.sin(a) });
        }
        const box: { x: number; y: number }[] = [];
        const corners = [
          { x: 100, y: 100 },
          { x: 340, y: 100 },
          { x: 340, y: 240 },
          { x: 100, y: 240 },
          { x: 100, y: 100 },
        ];
        for (let c = 0; c < corners.length - 1; c += 1) {
          for (let i = 0; i < 12; i += 1) {
            box.push({
              x: corners[c]!.x + ((corners[c + 1]!.x - corners[c]!.x) * i) / 12,
              y: corners[c]!.y + ((corners[c + 1]!.y - corners[c]!.y) * i) / 12,
            });
          }
        }
        box.push({ x: 100, y: 100 });
        const line: { x: number; y: number }[] = [];
        for (let i = 0; i <= 20; i += 1) {
          line.push({ x: 200 + i * 15, y: 500 + (i % 2) });
        }
        const vertical: { x: number; y: number }[] = [];
        for (let i = 0; i <= 20; i += 1) {
          vertical.push({ x: 600 + (i % 2), y: 200 + i * 12 });
        }
        const tapPts = [
          { x: 50, y: 50 },
          { x: 52, y: 51 },
          { x: 53, y: 52 },
        ];
        return {
          circle: recognize(circle),
          box: recognize(box),
          line: recognize(line),
          vertical: recognize(vertical),
          tap: recognize(tapPts),
        };
      });

      expect(result.circle?.kind).toBe("ellipse");
      expect(result.box?.kind).toBe("rectangle");
      expect(result.line?.kind).toBe("line");
      expect(result.vertical?.kind).toBe("rectangle");
      expect(result.tap).toBeNull();
      await evidence(page, "g3-recognition");
    } finally {
      await browser.close();
    }
  });

  test("G4a fit: long English and Korean transcripts never grow the container", async () => {
    const { browser, page } = await launchWithClip(ensureSilenceClip());
    try {
      const english =
        "The whiteboard session ran long today so we captured every decision about the release train, " +
        "the staging refresh, the operator handover and the follow up meeting that nobody wanted to " +
        "schedule before the quarter actually ends here";
      const korean = "이번 주 목표는 음성 인식으로 화이트보드 입력 속도를 세 배로 올리는 것입니다";

      const measured = await page.evaluate(
        ({ en, ko }: { en: string; ko: string }) => {
          const voice = window.__excalidrawVoice!;
          const style = {
            strokeColor: "#1e1e1e",
            backgroundColor: "transparent",
            fillStyle: "solid",
            strokeWidth: 2,
            strokeStyle: "solid",
            roughness: 1,
            opacity: 100,
            roundness: null,
            fontFamily: 5,
          } as unknown as StyleSnapshot;
          // 120x80 is the hostile end of the declared shape envelope, not the 240x120 the round-1 gate used.
          const run = (transcript: string, width: number, height: number) => {
            const placeholder = voice.fit.buildPlaceholder(
              { kind: "rectangle", x: 100, y: 100, width, height },
              style,
            );
            const [container, text] = placeholder.elements;
            const committed = voice.fit.commitText(
              placeholder.target,
              container!,
              text as never,
              transcript,
              style,
            );
            const nextContainer = committed[0]!;
            const nextText = committed[1] as unknown as {
              fontSize: number;
              containerId: string | null;
              text: string;
            };
            return {
              width: nextContainer.width,
              height: nextContainer.height,
              containerId: nextText.containerId,
              expectedContainerId: nextContainer.id,
              fontSize: nextText.fontSize,
              text: nextText.text,
            };
          };
          return {
            en: run(en, 240, 120),
            ko: run(ko, 240, 120),
            koSmall: run(ko, 120, 80),
          };
        },
        { en: english, ko: korean },
      );

      for (const [label, m] of Object.entries(measured)) {
        const expectedWidth = label === "koSmall" ? 120 : 240;
        const expectedHeight = label === "koSmall" ? 80 : 120;
        expect(m.width, `${label} width`).toBeCloseTo(expectedWidth, 0);
        expect(m.height, `${label} height`).toBeCloseTo(expectedHeight, 0);
        expect(m.fontSize, `${label} fontSize`).toBeGreaterThanOrEqual(10);
        expect(m.fontSize, `${label} fontSize`).toBeLessThanOrEqual(96);
        expect(m.containerId, `${label} binding`).toBe(m.expectedContainerId);
        expect((m.text ?? "").length, `${label} text`).toBeGreaterThan(0);
      }
      await evidence(page, "g4a-fit-direct");
    } finally {
      await browser.close();
    }
  });

  test("G4b fit: a horizontal stroke becomes a line with text sitting on it", async () => {
    const { browser, page } = await launchWithClip(EN_SHORT);
    try {
      const view = await transform(page);
      const path = linePath({ x: 450, y: 600 }, { x: 850, y: 600 }, 16);
      const t0 = await armHold(page);
      await drawStroke(page, path, { stepMs: 16 });
      await expect.poll(async () => shapes(await elements(page), "line").length, { timeout: 15_000 }).toBe(1);
      // en-short.wav is 2.4 s and plays once: 4.5 s covers the sentence and the silence that closes the utterance.
      await waitUntilWall(page, t0, 4_500);
      await releaseHold(page);

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);

      const els = await elements(page);
      const line = shapes(els, "line")[0]!;
      const text = finalTexts(els)[0]!;
      const expected = sceneBBox(view, path);
      expect(text.containerId).toBeNull();
      expect(Math.abs(text.angle)).toBeLessThan(0.05);
      expect(text.width).toBeLessThanOrEqual(expected.width + 2);
      expect(text.y + text.height).toBeLessThanOrEqual(line.y + 2);
      await evidence(page, "g4b-line-horizontal");
    } finally {
      await browser.close();
    }
  });

  test("G4c fit: text on a slanted line follows the slope", async () => {
    const { browser, page } = await launchWithClip(EN_SHORT);
    try {
      const path = linePath({ x: 450, y: 620 }, { x: 750, y: 740 }, 16);
      const t0 = await armHold(page);
      await drawStroke(page, path, { stepMs: 16 });
      await expect.poll(async () => shapes(await elements(page), "line").length, { timeout: 15_000 }).toBe(1);
      await waitUntilWall(page, t0, 4_500);
      await releaseHold(page);

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);

      const els = await elements(page);
      const text = finalTexts(els)[0]!;
      expect(Math.abs(text.angle - Math.atan2(120, 300))).toBeLessThan(0.05);
      await evidence(page, "g4c-line-slanted");
    } finally {
      await browser.close();
    }
  });

  test("G4d fit: a short line wraps its sentence instead of shrinking past legibility", async () => {
    // One 120 px line and the whole fixture: three sentences, the last of them the long Korean one, all land on
    // this line. The hostile end of the line envelope — round 1 answered it by shrinking the text to 10 px.
    const { browser, page } = await launchWithClip(THREE);
    try {
      const path = linePath({ x: 600, y: 500 }, { x: 720, y: 500 }, 10);
      const t0 = await armHold(page);
      await drawStroke(page, path, { stepMs: 16 });
      await expect.poll(async () => shapes(await elements(page), "line").length, { timeout: 15_000 }).toBe(1);
      await waitUntilWall(page, t0, 15_000);
      await releaseHold(page);
      await settled(page, 3);

      await expect
        .poll(async () => joined(await elements(page)), { timeout: 40_000 })
        .toMatch(/화이트보드|목표/);

      const els = await elements(page);
      const line = shapes(els, "line")[0]!;
      const text = finalTexts(els)[0]!;
      expect(finalTexts(els).length, "one text, on the line").toBe(1);
      expect(text.containerId, "line text is free, not bound").toBeNull();
      expect(text.fontSize ?? 0, "legible floor").toBeGreaterThanOrEqual(DEFAULT_SETTINGS.lineMinFontSize);
      expect(text.width, "wrapped to the line, not spilling past its ends").toBeLessThanOrEqual(122);
      expect(text.text ?? "", "wrapped onto several lines").toContain("\n");
      expect(text.y + text.height, "sits above the line").toBeLessThanOrEqual(line.y + 2);
      expect((await status(page)).orphans, "every sentence found the line").toBe(0);
      await evidence(page, "g4d-line-legibility");
    } finally {
      await browser.close();
    }
  });

  test("G5a failure: unreachable STT shows the warning, retry recovers the transcript", async () => {
    const { browser, page } = await launchWithClip(EN_SHORT);
    try {
      await setSettings(page, { sttUrl: "http://127.0.0.1:9" });
      const t0 = await armHold(page);
      await drawStroke(page, oval({ x: 700, y: 420 }, 20), { stepMs: 16 });
      await waitUntilWall(page, t0, 4_500);
      await releaseHold(page);

      await expect
        .poll(async () => texts(await elements(page)).map((el) => el.text ?? "").join(" "), {
          timeout: 30_000,
        })
        .toContain("⚠ STT");
      expect((await status(page)).failed).toBe(1);
      const failedEls = await elements(page);
      const failedContainer = shapes(failedEls, "ellipse")[0]!;
      expect(failedContainer, "the stroke must have become a container").toBeTruthy();
      expect(texts(failedEls).find((el) => (el.text ?? "").includes("STT"))?.containerId).toBe(
        failedContainer.id,
      );
      await evidence(page, "g5a-failure");

      await setSettings(page, { sttUrl: STT_URL });
      await page.evaluate(() => window.__excalidrawVoice!.controller.retryFailed());

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);
      await expect.poll(async () => (await status(page)).failed, { timeout: 10_000 }).toBe(0);
      const retried = await elements(page);
      expect(finalTexts(retried)[0]!.containerId).toBe(failedContainer.id);
      await evidence(page, "g5a-failure-retry");
    } finally {
      await browser.close();
    }
  });

  test("G5b failure: silence leaves the shape and removes the placeholder", async () => {
    const { browser, page } = await launchWithClip(`${ensureSilenceClip()}%noloop`);
    try {
      const t0 = await armHold(page);
      await drawStroke(page, oval({ x: 700, y: 420 }, 20), { stepMs: 16 });
      await expect.poll(async () => texts(await elements(page)).length, { timeout: 15_000 }).toBe(1);
      const placeholder = texts(await elements(page))[0]!;
      expect(isPlaceholder(placeholder)).toBe(true);
      await waitUntilWall(page, t0, 3_000);
      // The VAD never opened an utterance, so nothing is ever dispatched: the placeholder must go at the disarm.
      expect((await status(page)).utterances).toBe(0);
      await releaseHold(page);

      await expect
        .poll(
          async () => {
            const all = await elements(page, true);
            const text = all.find((el) => el.id === placeholder.id);
            return !text || text.isDeleted;
          },
          { timeout: 30_000 },
        )
        .toBe(true);

      const els = await elements(page);
      const ellipse = shapes(els, "ellipse")[0]!;
      expect(ellipse, "the shape the founder drew is kept").toBeTruthy();
      expect(ellipse.strokeStyle).toBe("solid");
      expect(texts(els).length).toBe(0);
      expect((await status(page)).failed).toBe(0);
      await evidence(page, "g5b-silence");
    } finally {
      await browser.close();
    }
  });

  test("G5c failure: deleting the shape while pending drops the result silently", async () => {
    const { browser, page } = await launchWithClip(THREE);
    try {
      // The stroke claims the fixture's first sentence; the VAD's silence closes it and dispatches it while the
      // hold is still running, which is the window this gate deletes in.
      const t0 = await armHold(page);
      await drawStroke(page, oval({ x: 700, y: 420 }, 20), { stepMs: 16 });
      // rAF-paced, so the delete lands well inside the round trip of a ~2 s utterance.
      await page.waitForFunction(() => window.__excalidrawVoice!.status().pending > 0, undefined, {
        timeout: 30_000,
      });

      const doomed = await elements(page);
      const ids = [shapes(doomed, "ellipse")[0]!.id, texts(doomed)[0]!.id];
      await page.evaluate((deleted: string[]) => {
        const api = window.__excalidrawVoice!.api;
        const next = api
          .getSceneElementsIncludingDeleted()
          .map((el) =>
            deleted.includes(el.id) ? ({ ...el, isDeleted: true, version: el.version + 1 } as typeof el) : el,
          );
        api.updateScene({ elements: next });
      }, ids);
      await releaseHold(page);
      void t0;

      await expect.poll(async () => (await status(page)).pending, { timeout: 40_000 }).toBe(0);
      const final = await status(page);
      expect(final.failed).toBe(0);
      expect(final.completed, "nothing was committed anywhere").toBe(0);
      const els = await elements(page);
      expect(texts(els).length).toBe(0);
      expect(shapes(els, "ellipse").length).toBe(0);
      await evidence(page, "g5c-delete-pending");
    } finally {
      await browser.close();
    }
  });

  test("G6 continuity: a vanilla scene survives the wrapper and reloads", async () => {
    const seededElements = [
      {
        id: "seed-rect-00000000001",
        type: "rectangle",
        x: 320,
        y: 180,
        width: 220,
        height: 120,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
        seed: 1_968_410_350,
        version: 24,
        versionNonce: 1_150_084_233,
        index: "a0",
        isDeleted: false,
        boundElements: null,
        updated: 1_726_000_000_000,
        link: null,
        locked: false,
      },
      {
        id: "seed-text-00000000001",
        type: "text",
        x: 320,
        y: 360,
        width: 180,
        height: 25,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 271_828_182,
        version: 11,
        versionNonce: 314_159_265,
        index: "a1",
        isDeleted: false,
        boundElements: null,
        updated: 1_726_000_000_000,
        link: null,
        locked: false,
        text: "seeded whiteboard note",
        fontSize: 20,
        fontFamily: 5,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        originalText: "seeded whiteboard note",
        lineHeight: 1.25,
        autoResize: true,
      },
    ];
    const { browser, page } = await launchWithClip(EN_SHORT, {
      seed: {
        excalidraw: JSON.stringify(seededElements),
        "excalidraw-state": JSON.stringify({ viewBackgroundColor: "#fffce8" }),
      },
    });
    try {
      const ids = async () => (await elements(page)).map((el) => el.id);
      expect(await ids()).toEqual(expect.arrayContaining(["seed-rect-00000000001", "seed-text-00000000001"]));
      const background = () =>
        page.evaluate(() => window.__excalidrawVoice!.api.getAppState().viewBackgroundColor);
      expect(await background()).toBe("#fffce8");

      await page.reload();
      await waitForVoiceReady(page);
      expect(await ids()).toEqual(expect.arrayContaining(["seed-rect-00000000001", "seed-text-00000000001"]));
      expect(await background()).toBe("#fffce8");

      const t0 = await armHold(page);
      await drawStroke(page, oval({ x: 1000, y: 500 }, 20), { stepMs: 16 });
      await waitUntilWall(page, t0, 4_500);
      await releaseHold(page);
      // The seeded note is also a transcript-shaped text, so the assertion follows the CONTAINER binding.
      await expect
        .poll(
          async () => {
            const els = await elements(page);
            const container = shapes(els, "ellipse")[0];
            return container ? boundText(els, container.id) : "";
          },
          { timeout: 30_000 },
        )
        .toMatch(/voice/i);
      const withVoice = await elements(page);
      const spokenContainer = shapes(withVoice, "ellipse")[0]!;
      const spoken = finalTexts(withVoice).find((el) => el.containerId === spokenContainer.id)!;

      // Give the 300 ms debounce a chance before the reload races it (beforeunload flushes anyway).
      await page.waitForTimeout(600);
      await page.reload();
      await waitForVoiceReady(page);
      const after = await elements(page);
      expect(after.map((el) => el.id)).toEqual(
        expect.arrayContaining([
          "seed-rect-00000000001",
          "seed-text-00000000001",
          spokenContainer.id,
          spoken.id,
        ]),
      );
      expect(after.find((el) => el.id === spoken.id)?.text).toBe(spoken.text);
      expect(after.find((el) => el.id === spoken.id)?.containerId).toBe(spokenContainer.id);
      await evidence(page, "g6-continuity");
    } finally {
      await browser.close();
    }
  });

  test("native tool modifier: a rectangle drawn with the native tool takes the transcript", async () => {
    const { browser, page } = await launchWithClip(EN_SHORT);
    try {
      await page.locator('label.ToolIcon:has([data-testid="toolbar-rectangle"])').click();
      await expect
        .poll(async () => page.evaluate(() => window.__excalidrawVoice!.api.getAppState().activeTool.type))
        .toBe("rectangle");

      const t0 = await armHold(page);
      await page.mouse.move(500, 300);
      await page.mouse.down();
      for (let i = 1; i <= 12; i += 1) {
        await page.mouse.move(500 + (300 * i) / 12, 300 + (150 * i) / 12);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      await expect
        .poll(async () => shapes(await elements(page), "rectangle").length, { timeout: 15_000 })
        .toBe(1);
      await waitUntilWall(page, t0, 4_500);
      await releaseHold(page);

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);
      const els = await elements(page);
      const rect = shapes(els, "rectangle")[0]!;
      expect(shapes(els, "ellipse").length).toBe(0);
      expect(finalTexts(els).length).toBe(1);
      expect(finalTexts(els)[0]!.containerId).toBe(rect.id);
      expect(Math.abs(rect.width - 300)).toBeLessThanOrEqual(3);
      expect(Math.abs(rect.height - 150)).toBeLessThanOrEqual(3);
      expect(rect.strokeStyle).toBe("solid");
      await evidence(page, "native-tool-modifier");
    } finally {
      await browser.close();
    }
  });

  test("toolbar latch: tapping the voice tool arms and disarms it", async () => {
    const { browser, page } = await launchWithClip(EN_SHORT);
    try {
      const button = page.locator('[data-testid="toolbar-voice"]');
      await button.click();
      await expect.poll(async () => (await status(page)).mode, { timeout: 10_000 }).toBe("latched");
      await expect(button).toHaveClass(/voice-tool--armed/);
      await page.waitForFunction(() => window.__excalidrawVoice!.status().recording === true, undefined, {
        timeout: 15_000,
      });

      await drawStroke(page, oval({ x: 700, y: 450 }, 20), { stepMs: 16 });
      await page.waitForTimeout(4_000);
      await button.click();
      await expect.poll(async () => (await status(page)).mode, { timeout: 10_000 }).toBe("idle");

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);
      const latched = await elements(page);
      const latchedContainer = shapes(latched, "ellipse")[0]!;
      expect(latchedContainer, "the stroke must have become a container").toBeTruthy();
      expect(boundText(latched, latchedContainer.id)).toMatch(/voice/i);
      await expect(button).not.toHaveClass(/voice-tool--armed/);
      await evidence(page, "toolbar-latch");
    } finally {
      await browser.close();
    }
  });

  // --- round 2 gates ------------------------------------------------------

  test("N6a assignment: draw then speak keeps each sentence in the shape that was drawn for it", async () => {
    const { browser, page } = await launchWithClip(THREE);
    try {
      const t0 = await armHold(page);
      await drawStroke(page, oval(N6_SPOTS[0]!), { stepMs: 14 });
      await waitUntilWall(page, t0, 3_200);
      await drawStroke(page, oval(N6_SPOTS[1]!), { stepMs: 14 });
      await waitUntilWall(page, t0, 7_200);
      await drawStroke(page, oval(N6_SPOTS[2]!), { stepMs: 14 });
      await waitUntilWall(page, t0, 15_000);
      await releaseHold(page);

      await settled(page, 3);
      await assertThreeUtteranceWords(page);
      expect((await status(page)).orphans).toBe(0);
      await evidence(page, "n6a-draw-then-speak");
    } finally {
      await browser.close();
    }
  });

  test("N6b assignment: speaking first and drawing a beat later lands in the same shapes", async () => {
    const { browser, page } = await launchWithClip(THREE);
    try {
      const t0 = await armHold(page);
      // Each stroke starts AFTER its sentence has begun: the pre-roll is what makes "say it, then box it" work.
      await waitUntilWall(page, t0, 1_200);
      await drawStroke(page, oval(N6_SPOTS[0]!), { stepMs: 14 });
      await waitUntilWall(page, t0, 4_800);
      await drawStroke(page, oval(N6_SPOTS[1]!), { stepMs: 14 });
      await waitUntilWall(page, t0, 8_800);
      await drawStroke(page, oval(N6_SPOTS[2]!), { stepMs: 14 });
      await waitUntilWall(page, t0, 15_000);
      await releaseHold(page);

      await settled(page, 3);
      await assertThreeUtteranceWords(page);
      expect((await status(page)).orphans).toBe(0);
      await evidence(page, "n6b-speak-then-draw");
    } finally {
      await browser.close();
    }
  });

  test("N6c assignment: a palm tap between strokes changes nothing", async () => {
    const { browser, page } = await launchWithClip(THREE);
    try {
      const t0 = await armHold(page);
      await drawStroke(page, oval(N6_SPOTS[0]!), { stepMs: 14 });
      await waitUntilWall(page, t0, 3_200);
      await drawStroke(page, oval(N6_SPOTS[1]!), { stepMs: 14 });
      await waitUntilWall(page, t0, 5_000);
      // A palm contact mid-sentence: it must neither become a shape nor claim the speech in flight.
      await tap(page, { x: 1400, y: 800 }, 3);
      await waitUntilWall(page, t0, 7_200);
      await drawStroke(page, oval(N6_SPOTS[2]!), { stepMs: 14 });
      await waitUntilWall(page, t0, 15_000);
      await releaseHold(page);

      await settled(page, 3);
      const els = await assertThreeUtteranceWords(page);
      expect(shapes(els, "freedraw").length, "the tap left no ink").toBe(0);
      expect(els.length, "three shapes and their three texts, nothing else").toBe(6);
      await evidence(page, "n6c-palm-tap");
    } finally {
      await browser.close();
    }
  });

  test("N2a boundary: a zero-gap stroke pair produces two containers, both filled", async () => {
    const { browser, page } = await launchWithClip(THREE);
    try {
      // Pre-roll off for this case only. With the default 1.5 s the rule itself decides the outcome: the pair's
      // pointer-downs are ~200 ms apart, so any utterance either stroke could claim goes to the LATER one and the
      // first shape is empty by design, not by race. At preRoll 0 each sentence belongs to the stroke drawn
      // before it started, which is what makes "did the zero gap lose a stroke?" the only open question here.
      await setSettings(page, { preRollMs: 0 });
      await recordUtterances(page);
      const t0 = await armHold(page);

      // Two strokes with no wait at all between the first pointer-up and the second pointer-down: round 1's
      // deferred capture had a ~45 ms window here in which the second stroke was silently dropped (RETRO L3).
      await drawStroke(page, oval({ x: 420, y: 300 }, 14), { stepMs: 14, settleMs: 0 });
      await drawStroke(page, oval({ x: 1080, y: 300 }, 14), { stepMs: 14, leadMs: 0 });

      await waitUntilWall(page, t0, 12_000);
      await releaseHold(page);
      await settled(page, 3, 3);

      const els = await elements(page);
      expect(shapes(els, "freedraw").length, "no stroke was left as raw ink").toBe(0);
      expect(shapes(els, "ellipse").length, "exactly one container per stroke").toBe(2);
      const a = nearest(els, "ellipse", { x: 420, y: 300 })!;
      const b = nearest(els, "ellipse", { x: 1080, y: 300 })!;
      expect(a.id).not.toBe(b.id);
      expect(boundText(els, a.id), "first container kept the first sentence").toMatch(/회의/);
      expect(boundText(els, b.id), "second container kept what followed").toMatch(/voice/i);
      expect(boundText(els, a.id)).not.toMatch(/voice/i);
      expect((await status(page)).orphans, "no sentence fell between the two strokes").toBe(0);
      await evidence(page, "n2a-zero-gap");
    } finally {
      await browser.close();
    }
  });

  test("N2b boundary: disarming 5 ms after pointer-up still converts the stroke", async () => {
    const { browser, page } = await launchWithClip(THREE);
    try {
      await recordUtterances(page);
      await armHold(page);
      const first = await waitForUtterance(page, 1);
      await waitCaptureUntil(page, first.onsetMs + 900);
      await drawStroke(page, oval({ x: 700, y: 420 }, 14), { stepMs: 14, settleMs: 0 });
      // Inside the controller's deferred-capture window: round 1 lost the whole stroke here.
      await page.waitForTimeout(5);
      await releaseHold(page);

      await settled(page, 1, 1);
      const els = await elements(page);
      expect(shapes(els, "freedraw").length, "not raw freedraw ink").toBe(0);
      const ellipse = shapes(els, "ellipse")[0];
      expect(ellipse, "the stroke became a container").toBeTruthy();
      expect(shapes(els, "ellipse").length).toBe(1);
      expect(boundText(els, ellipse!.id).trim(), "the speech in flight still landed").not.toBe("");
      await evidence(page, "n2b-disarm-in-window");
    } finally {
      await browser.close();
    }
  });

  test("N2c boundary: undo while armed does not make the next stroke convert the old one", async () => {
    const { browser, page } = await launchWithClip(`${ensureSilenceClip()}%noloop`);
    try {
      await armHold(page);
      const aCenter = { x: 420, y: 320 };
      const bCenter = { x: 1080, y: 560 };
      await drawStroke(page, oval(aCenter, 14), { stepMs: 14 });
      await expect.poll(async () => shapes(await elements(page), "ellipse").length, { timeout: 15_000 }).toBe(1);

      await page.keyboard.press("Control+z");
      // The undo of the placeholder step restores the raw freedraw stroke: the shape and its placeholder go away.
      await expect.poll(async () => shapes(await elements(page), "ellipse").length, { timeout: 10_000 }).toBe(0);
      const undone = await elements(page);
      expect(shapes(undone, "freedraw").length, "A is ink again").toBe(1);
      expect(texts(undone).length, "A's placeholder went with it").toBe(0);

      await drawStroke(page, oval(bCenter, 14), { stepMs: 14 });
      await expect.poll(async () => shapes(await elements(page), "ellipse").length, { timeout: 15_000 }).toBe(1);

      const els = await elements(page);
      const ellipse = shapes(els, "ellipse")[0]!;
      expect(Math.abs(ellipse.x + ellipse.width / 2 - bCenter.x), "the placeholder is at B").toBeLessThanOrEqual(4);
      expect(Math.abs(ellipse.y + ellipse.height / 2 - bCenter.y)).toBeLessThanOrEqual(4);
      expect(ellipse.strokeStyle).toBe("dashed");
      const placeholders = texts(els).filter(isPlaceholder);
      expect(placeholders.length, "exactly one placeholder, B's").toBe(1);
      expect(placeholders[0]!.containerId).toBe(ellipse.id);
      // A's restored ink is still ink: the undone stroke was never converted a second time.
      expect(shapes(els, "freedraw").length).toBe(1);
      await evidence(page, "n2c-undo-while-armed");

      await releaseHold(page);
    } finally {
      await browser.close();
    }
  });

  test("N2d boundary: undoing the shape before speaking keeps the words as an orphan", async () => {
    // The races lens lost a whole sentence here: the stroke record outlived the shape, assign.ts kept handing the
    // utterance to the undone target and the transcript was dropped on the way in with no ⚠ and no status.
    const { browser, page } = await launchWithClip(EN_SHORT);
    try {
      await recordUtterances(page);
      const t0 = await armHold(page);
      await drawStroke(page, oval({ x: 700, y: 420 }, 12), { stepMs: 12 });
      await expect.poll(async () => shapes(await elements(page), "ellipse").length, { timeout: 15_000 }).toBe(1);

      // Ctrl+Z while the sentence is still being spoken: the placeholder pair leaves the scene mid-utterance.
      await page.keyboard.press("Control+z");
      await expect.poll(async () => shapes(await elements(page), "ellipse").length, { timeout: 10_000 }).toBe(0);
      expect(texts(await elements(page)).length, "the placeholder went with it").toBe(0);

      const utterance = await waitForUtterance(page, 1);
      await waitCaptureUntil(page, utterance.onsetMs + PRE_ROLL_MS + 250);
      await releaseHold(page);
      void t0;

      await expect.poll(async () => joined(await elements(page)), { timeout: 40_000 }).toMatch(/voice tool/i);
      const s = await status(page);
      expect(s.orphans, "the utterance fell through to the orphan path").toBe(1);
      expect(s.completed).toBe(1);
      const els = await elements(page);
      const placed = finalTexts(els);
      expect(placed.length, "exactly one text carries the sentence").toBe(1);
      expect(placed[0]!.containerId, "free text, not bound to the shape the founder undid").toBeNull();
      expect(shapes(els, "ellipse").length, "the undone shape stays undone").toBe(0);
      expect(shapes(els, "freedraw").length, "the restored ink is still ink").toBe(1);
      await evidence(page, "n2d-undo-before-speech");
    } finally {
      await browser.close();
    }
  });

  test("N3 visible failure: a denied microphone refuses to arm and says so", async () => {
    const { browser, page } = await launchWithClip(ensureSilenceClip(), { denyMic: true });
    try {
      const toolBefore = await page.evaluate(
        () => window.__excalidrawVoice!.api.getAppState().activeTool.type,
      );
      await page.keyboard.down("F9");
      // Headless Chromium refuses an ungranted getUserMedia with NotSupportedError rather than NotAllowedError,
      // so the exact MicState is the browser's business; what this gate is about is that the tool refuses to arm
      // and says why. (Measured: mic "error", lastError "microphone: error (Not supported)".)
      await expect.poll(async () => (await status(page)).mic, { timeout: 20_000 }).not.toBe("unknown");
      await page.keyboard.up("F9");

      const s = await status(page);
      expect(["denied", "missing", "error"], "the mic failure is typed").toContain(s.mic);
      expect(s.mode, "never armed").toBe("idle");
      expect(s.recording).toBe(false);
      expect(s.lastError ?? "", "the failure reached the status channel").toContain("microphone");
      await expect(page.locator('[data-testid="toolbar-voice"]')).toHaveClass(/voice-tool--mic-missing/);
      expect(
        await page.evaluate(() => window.__excalidrawVoice!.api.getAppState().activeTool.type),
        "no freedraw hijack without a microphone",
      ).toBe(toolBefore);

      // A stroke now is an ordinary drawing action, not a placeholder nothing can ever fill.
      await drawStroke(page, oval({ x: 700, y: 450 }, 14), { stepMs: 14 });
      const els = await elements(page);
      expect(shapes(els, "ellipse").length).toBe(0);
      expect(texts(els).length).toBe(0);
      await evidence(page, "n3-mic-denied");
    } finally {
      await browser.close();
    }
  });

  test("N5 zoom invariance: the same physical gesture recognises the same at zoom 0.5 and 2", async () => {
    const { browser, page } = await launchWithClip(`${ensureSilenceClip()}%noloop`);
    try {
      for (const zoom of [0.5, 2]) {
        await page.evaluate((value: number) => {
          window.__excalidrawVoice!.api.updateScene({ appState: { zoom: { value: value as never } } });
        }, zoom);
        await expect.poll(async () => (await transform(page)).zoom).toBe(zoom);
        const view = await transform(page);

        await armHold(page);
        const path = oval({ x: 700, y: 450 }, 16); // 300 x 160 SCREEN px at either zoom
        const expectedBox = sceneBBox(view, path);
        await drawStroke(page, path, { stepMs: 14 });
        // 6 screen px of jitter: a palm contact, at any zoom.
        await tap(page, { x: 300, y: 720 }, 6);
        await page.waitForTimeout(400);

        const els = await elements(page);
        const ellipse = shapes(els, "ellipse")[0];
        expect(ellipse, `an ellipse at zoom ${zoom}`).toBeTruthy();
        expect(shapes(els, "ellipse").length, `one ellipse at zoom ${zoom}`).toBe(1);
        expect(ellipse!.width, `scene width at zoom ${zoom}`).toBeCloseTo(300 / zoom, 0);
        expect(ellipse!.height, `scene height at zoom ${zoom}`).toBeCloseTo(160 / zoom, 0);
        expect(Math.abs(ellipse!.x - expectedBox.x), `scene x at zoom ${zoom}`).toBeLessThanOrEqual(2);
        expect(shapes(els, "freedraw").length, `the tap left no ink at zoom ${zoom}`).toBe(0);
        expect(els.length, `only the ellipse and its placeholder at zoom ${zoom}`).toBe(2);
        await evidence(page, `n5-zoom-${zoom}`);

        await releaseHold(page);
        await expect.poll(async () => (await status(page)).mode, { timeout: 10_000 }).toBe("idle");
        await page.evaluate(() => window.__excalidrawVoice!.api.updateScene({ elements: [] }));
        await expect.poll(async () => (await elements(page)).length).toBe(0);
      }
      await evidence(page, "n5-zoom");
    } finally {
      await browser.close();
    }
  });

  test("R3 ghosts: a placeholder left by a reload is swept back to a plain shape", async () => {
    const ghost = [
      {
        id: "ghost-rect-0000000001",
        type: "rectangle",
        x: 400,
        y: 260,
        width: 260,
        height: 140,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "dashed",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 3 },
        seed: 123_456_789,
        version: 7,
        versionNonce: 987_654_321,
        index: "a0",
        isDeleted: false,
        boundElements: [{ id: "ghost-text-0000000001", type: "text" }],
        updated: 1_726_000_000_000,
        link: null,
        locked: false,
      },
      {
        id: "ghost-text-0000000001",
        type: "text",
        x: 500,
        y: 310,
        width: 24,
        height: 35,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 192_837_465,
        version: 3,
        versionNonce: 564_738_291,
        index: "a1",
        isDeleted: false,
        boundElements: null,
        updated: 1_726_000_000_000,
        link: null,
        locked: false,
        text: "··",
        fontSize: 28,
        fontFamily: 5,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: "ghost-rect-0000000001",
        originalText: "··",
        lineHeight: 1.25,
        autoResize: true,
      },
    ];
    const { browser, page } = await launchWithClip(`${ensureSilenceClip()}%noloop`, {
      seed: { excalidraw: JSON.stringify(ghost) },
    });
    try {
      const els = await elements(page);
      const rect = els.find((el) => el.id === "ghost-rect-0000000001");
      expect(rect, "the founder's shape survives the sweep").toBeTruthy();
      expect(rect!.strokeStyle, "the pending cue is gone").toBe("solid");
      expect(rect!.width).toBe(260);
      expect(rect!.height).toBe(140);
      expect(rect!.boundElements ?? [], "the ghost is unbound").toHaveLength(0);
      expect(texts(els).some((el) => isPlaceholder(el)), "no placeholder text is left").toBe(false);
      expect(els.find((el) => el.id === "ghost-text-0000000001"), "the ghost text is gone").toBeUndefined();
      await evidence(page, "r3-ghost-sweep");
    } finally {
      await browser.close();
    }
  });
});
