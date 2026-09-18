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
 * Round 4a makes the drawn shape a REGION MARKER instead of a drawing: while a take is pending the scene shows a
 * dashed marker (helpers.markers) with the animated placeholder in it, and a commit deletes that marker and leaves
 * the transcript behind as a FREE text element fitted to the region's bounding box. So the geometry assertions read
 * "no marker is left, and exactly one free text sits inside the box the founder drew" — never "the shape kept its
 * label".
 *
 * One browser per test (the clip is a launch flag) and one screenshot per gate under test-results/evidence/.
 */
import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_SETTINGS, type StyleSnapshot } from "../../../excalidraw-app/voice/contracts";
import {
  armHold,
  drawStroke,
  elements,
  ellipsePath,
  ensureLeadInClip,
  ensureSilenceClip,
  evidence,
  fixture,
  isPlaceholder,
  launchWithClip,
  linePath,
  markers,
  micGlyph,
  readMicGlyphWatch,
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
  watchMicGlyph,
  watchWords,
  readWords,
  stopWords,
  type Pt,
  type SceneEl,
} from "./helpers";

const STT_URL = "http://100.81.33.83:8770";
const PRE_ROLL_MS = DEFAULT_SETTINGS.preRollMs;

const THREE = `${fixture("three-utterances.wav")}%noloop`;
const EN_SHORT = `${fixture("en-short.wav")}%noloop`;
const KO_SHORT = `${fixture("ko-short.wav")}%noloop`;
/**
 * The long Korean fixture with a second of silence in front (helpers.ensureLeadInClip): the VAD seeds its noise
 * floor from the first audio it hears, so a clip that opens on a loud syllable makes it deaf for seconds and its
 * 5.4 s of speech arrives as one 0.5 s utterance. Round 5's preview needs a LONG OPEN utterance, so it gets the
 * lead-in a real room would give it.
 */
const koLongOpen = (): string => `${ensureLeadInClip("ko-long.wav", 1200)}%noloop`;


/**
 * The COMMITTED transcripts. Two kinds of text look like one and are not: "⚠ STT" (a failure report) and a round-5
 * interim preview (the words so far, stamped `customData.voiceInterim`, overwritten by the commit). Every assertion
 * about "the words that landed" reads this, so a preview can never be mistaken for a take that finished.
 */
const finalTexts = (els: SceneEl[]): SceneEl[] =>
  transcriptTexts(els).filter(
    (el) => !(el.text ?? "").includes("STT") && el.customData?.voiceInterim !== true,
  );
/** Committed text is WRAPPED text: "fellow\nAmericans" is the same sentence, so word assertions read it flat. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
const joined = (els: SceneEl[]): string => finalTexts(els).map((el) => flat(el.text ?? "")).join(" | ");
type Box = { x: number; y: number; width: number; height: number };

/** Every pixel of `el` is inside `box` (±tol): what "the font fits inside the bounding box" means on screen. */
const insideBox = (el: SceneEl, box: Box, tol = 2): boolean =>
  el.x >= box.x - tol &&
  el.y >= box.y - tol &&
  el.x + el.width <= box.x + box.width + tol &&
  el.y + el.height <= box.y + box.height + tol;

/** The committed transcript of a region, identified by the box the founder drew rather than by a container id. */
const textIn = (els: SceneEl[], box: Box, tol = 2): SceneEl | undefined =>
  finalTexts(els).find((el) => insideBox(el, box, tol));
const wordsIn = (els: SceneEl[], box: Box, tol = 2): string => flat(textIn(els, box, tol)?.text ?? "");

const centerOf = (el: SceneEl): Pt => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });
/**
 * The committed text closest to a spot: with the marker gone, the text IS the region's identity. The timed cases
 * run at zoom 1 with no scroll, so a screen centre and a scene centre are the same point.
 */
const nearestText = (els: SceneEl[], at: Pt): SceneEl | undefined =>
  finalTexts(els)
    .slice()
    .sort((a, b) => Math.hypot(centerOf(a).x - at.x, centerOf(a).y - at.y) - Math.hypot(centerOf(b).x - at.x, centerOf(b).y - at.y))[0];
const wordsNear = (els: SceneEl[], at: Pt): string => flat(nearestText(els, at)?.text ?? "");

/**
 * Re-runs the real fitter, in the page, over a region and a transcript — the only way to ask "was that the LARGEST
 * font size that fits?" from outside: raise the ceiling to exactly one step above the size the app chose and the
 * answer must not move, because if `fontSize + 1` fitted the binary search would have taken it.
 */
const refit = (
  page: Page,
  region: Box,
  transcript: string,
  maxFontSize?: number,
): Promise<{ fontSize: number; containerId: string | null; autoResize: boolean }> =>
  page.evaluate(
    async (args: { region: Box; transcript: string; maxFontSize?: number }) => {
      const voice = window.__excalidrawVoice!;
      // The APP's own font gate (fit.warmFonts, awaited by App at boot and by the controller before it arms), not a
      // test-private `document.fonts.ready`: a gate may only assume what production provides.
      await voice.fit.warmFonts();
      const app = voice.api.getAppState();
      const style = {
        strokeColor: app.currentItemStrokeColor,
        backgroundColor: app.currentItemBackgroundColor,
        fillStyle: app.currentItemFillStyle,
        strokeWidth: app.currentItemStrokeWidth,
        strokeStyle: app.currentItemStrokeStyle,
        roughness: app.currentItemRoughness,
        opacity: app.currentItemOpacity,
        roundness: app.currentItemRoundness,
        fontFamily: app.currentItemFontFamily,
      } as unknown as StyleSnapshot;
      const built = voice.fit.buildPlaceholder({ kind: "rectangle", ...args.region }, style);
      const [marker, placeholder] = built.elements;
      const committed = voice.fit.commitText(
        built.target,
        placeholder as never,
        args.transcript,
        style,
        marker,
        args.maxFontSize === undefined ? undefined : { maxFontSize: args.maxFontSize },
      );
      const text = committed.find((el) => el.type === "text") as unknown as {
        fontSize: number;
        containerId: string | null;
        autoResize: boolean;
      };
      return { fontSize: text.fontSize, containerId: text.containerId, autoResize: text.autoResize };
    },
    { region, transcript, maxFontSize },
  );

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
  expect(markers(els).length, "every region marker left with its transcript").toBe(0);
  expect(finalTexts(els).length, "one text per stroke, nothing else").toBe(3);
  const found = N6_SPOTS.map((spot) => nearestText(els, spot)!);
  expect(new Set(found.map((el) => el.id)).size, "each stroke's words landed in its own region").toBe(3);
  const spoken = found.map((el) => flat(el.text ?? ""));

  expect(spoken[0], `shape 1 (${spoken.join(" | ")})`).toMatch(/회의/);
  expect(spoken[1], `shape 2 (${spoken.join(" | ")})`).toMatch(/voice/i);
  expect(spoken[2], `shape 3 (${spoken.join(" | ")})`).toMatch(/화이트보드|목표/);
  expect(spoken[0], "shape 1 kept its neighbours' words out").not.toMatch(/voice|화이트보드|목표/i);
  expect(spoken[1], "shape 2 kept its neighbours' words out").not.toMatch(/회의|화이트보드|목표/);
  expect(spoken[2], "shape 3 kept its neighbours' words out").not.toMatch(/회의|voice/i);
  return els;
}

test.describe("voice areas", () => {
  test("G1 vertical slice: one stroke + speech leaves the words alone in the region", async () => {
    const { browser, page } = await launchWithClip(fixture("jfk.wav"));
    try {
      const view = await transform(page);
      const path = ellipsePath(700, 450, 150, 80, 32);
      const expected = sceneBBox(view, path);

      const t0 = await armHold(page);
      await drawStroke(page, path, { stepMs: 16 });
      await expect
        .poll(async () => markers(await elements(page)).length, { timeout: 15_000 })
        .toBe(1);

      // While the take is pending the region is a dashed rectangle on the stroke's own bounding box.
      const pending = await elements(page);
      const marker = markers(pending)[0]!;
      expect(marker.type, "the marker is the region's box, not a drawing of the oval").toBe("rectangle");
      expect(marker.strokeStyle).toBe("dashed");
      expect(Math.abs(marker.width - expected.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(marker.height - expected.height)).toBeLessThanOrEqual(2);
      expect(Math.abs(marker.x - expected.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(marker.y - expected.y)).toBeLessThanOrEqual(2);
      expect(texts(pending).filter(isPlaceholder).length, "the placeholder animates inside it").toBe(1);
      await evidence(page, "g1-region-pending");

      // The clip starts at the arm, so "And so, my fellow Americans," is the first utterance; 6 s covers it and
      // the VAD silence that closes it.
      await waitUntilWall(page, t0, 6_000);
      await releaseHold(page);

      await expect
        .poll(async () => joined(await elements(page)), { timeout: 30_000 })
        .toMatch(/fellow americans/i);

      const els = await elements(page);
      expect(markers(els).length, "the marker was only ever a region selector").toBe(0);
      expect(els.filter((el) => el.type !== "text").length, "nothing but text is left on the canvas").toBe(0);
      expect(els.length, "exactly one element: the transcript").toBe(1);

      const text = finalTexts(els)[0]!;
      expect(text.containerId, "free text: the box it was fitted in is gone").toBeNull();
      expect(text.autoResize, "fixed at the fitted width, so the wrapped lines stay put").toBe(false);
      expect(
        insideBox(text, expected),
        `text ${text.x},${text.y} ${text.width}x${text.height} inside ${JSON.stringify(expected)}`,
      ).toBe(true);

      // …and at the LARGEST size that fits: one step more ceiling changes nothing.
      const oneStepUp = await refit(page, expected, text.originalText ?? text.text ?? "", (text.fontSize ?? 0) + 1);
      expect(oneStepUp.fontSize, "the fitted size is maximal for this region").toBe(text.fontSize);
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

      // Still armed, still recording: the first two regions already carry their transcripts while the third is
      // being spoken — no stroke waited for a transcript. A region is either a live marker or an written text by
      // now, so the two counts together are what must account for all three strokes.
      const during = await elements(page);
      expect(
        markers(during).length + finalTexts(during).length,
        "three regions coexist, some already written",
      ).toBe(3);
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
      expect(markers(els).length, "no region marker survived its transcript").toBe(0);
      expect(finalTexts(els).length).toBe(3);
      for (const spot of spots) {
        expect(wordsNear(els, spot).length, `region at ${spot.x},${spot.y}`).toBeGreaterThan(0);
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

  test("G4a fit: long English and Korean transcripts stay inside the region they were spoken into", async () => {
    const { browser, page } = await launchWithClip(ensureSilenceClip());
    try {
      const english =
        "The whiteboard session ran long today so we captured every decision about the release train, " +
        "the staging refresh, the operator handover and the follow up meeting that nobody wanted to " +
        "schedule before the quarter actually ends here";
      const korean = "이번 주 목표는 음성 인식으로 화이트보드 입력 속도를 세 배로 올리는 것입니다";

      const measured = await page.evaluate(
        async ({ en, ko }: { en: string; ko: string }) => {
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
          // Text metrics depend on the web font actually being loaded, and the first measurement is what triggers
          // that load — which is why the APP has to do this too, and does: App awaits fit.warmFonts() at boot and
          // the controller awaits it before it arms, so this line is the production path, not a test fixture.
          await voice.fit.warmFonts();

          // 120x80 is the hostile end of the declared region envelope, not the 240x120 the round-1 gate used.
          const run = (transcript: string, width: number, height: number) => {
            const region = { kind: "rectangle" as const, x: 100, y: 100, width, height };
            const placeholder = voice.fit.buildPlaceholder(region, style);
            const [marker, text] = placeholder.elements;
            const committed = voice.fit.commitText(
              placeholder.target,
              text as never,
              transcript,
              style,
              marker,
            );
            const nextText = committed.find((el) => el.type === "text") as unknown as {
              fontSize: number;
              containerId: string | null;
              autoResize: boolean;
              text: string;
              x: number;
              y: number;
              width: number;
              height: number;
            };
            const goneMarker = committed.find((el) => el.id === marker!.id);
            // The same fit with the ceiling exactly one step above the chosen size, measured in the same tick and
            // against the same loaded fonts: if `fontSize + 1` fitted, the binary search would have taken it.
            const ceilingProbe = voice.fit.buildPlaceholder(region, style);
            const oneStepUp = voice.fit.commitText(
              ceilingProbe.target,
              ceilingProbe.elements[1] as never,
              transcript,
              style,
              ceilingProbe.elements[0],
              { maxFontSize: nextText.fontSize + 1 },
            );
            const capped = oneStepUp.find((el) => el.type === "text") as unknown as { fontSize: number };
            return {
              maximalFontSize: capped.fontSize,
              x: nextText.x,
              y: nextText.y,
              width: nextText.width,
              height: nextText.height,
              region,
              transcript,
              markerDeleted: !!goneMarker?.isDeleted,
              containerId: nextText.containerId,
              autoResize: nextText.autoResize,
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
        const box = { x: m.region.x, y: m.region.y, width: m.region.width, height: m.region.height };
        expect(m.x, `${label} left edge`).toBeGreaterThanOrEqual(box.x - 0.5);
        expect(m.y, `${label} top edge`).toBeGreaterThanOrEqual(box.y - 0.5);
        expect(m.x + m.width, `${label} right edge`).toBeLessThanOrEqual(box.x + box.width + 0.5);
        expect(m.y + m.height, `${label} bottom edge`).toBeLessThanOrEqual(box.y + box.height + 0.5);
        expect(m.fontSize, `${label} fontSize`).toBeGreaterThanOrEqual(10);
        expect(m.fontSize, `${label} fontSize`).toBeLessThanOrEqual(96);
        expect(m.containerId, `${label} is free text`).toBeNull();
        expect(m.autoResize, `${label} keeps its fitted width`).toBe(false);
        expect(m.markerDeleted, `${label} region marker is gone`).toBe(true);
        expect((m.text ?? "").length, `${label} text`).toBeGreaterThan(0);
        // …and it is the LARGEST size this region takes: raising the ceiling by one step changes nothing.
        expect(m.maximalFontSize, `${label} fitted size is maximal`).toBe(m.fontSize);
      }
      await evidence(page, "g4a-fit-direct");
    } finally {
      await browser.close();
    }
  });

  test("G4b fit: a horizontal stroke leaves its text where the line was", async () => {
    const { browser, page } = await launchWithClip(EN_SHORT);
    try {
      const view = await transform(page);
      const path = linePath({ x: 450, y: 600 }, { x: 850, y: 600 }, 16);
      const t0 = await armHold(page);
      await drawStroke(page, path, { stepMs: 16 });
      await expect.poll(async () => markers(await elements(page)).length, { timeout: 15_000 }).toBe(1);
      expect(markers(await elements(page))[0]!.type, "a line region is marked by a dashed line").toBe("line");
      // en-short.wav is 2.4 s and plays once: 4.5 s covers the sentence and the silence that closes the utterance.
      await waitUntilWall(page, t0, 4_500);
      await releaseHold(page);

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);

      const els = await elements(page);
      const text = finalTexts(els)[0]!;
      const expected = sceneBBox(view, path);
      expect(markers(els).length, "the line was a region marker, so it goes too").toBe(0);
      expect(shapes(els, "line").length).toBe(0);
      expect(els.length, "only the transcript is left").toBe(1);
      expect(text.containerId).toBeNull();
      expect(Math.abs(text.angle)).toBeLessThan(0.05);
      expect(text.width).toBeLessThanOrEqual(expected.width + 2);
      expect(text.y + text.height, "still sitting where the line's upper side was").toBeLessThanOrEqual(
        expected.y + 2,
      );
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
      await expect.poll(async () => markers(await elements(page)).length, { timeout: 15_000 }).toBe(1);
      await waitUntilWall(page, t0, 4_500);
      await releaseHold(page);

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);

      const els = await elements(page);
      const text = finalTexts(els)[0]!;
      expect(markers(els).length).toBe(0);
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
      const view = await transform(page);
      const path = linePath({ x: 600, y: 500 }, { x: 720, y: 500 }, 10);
      const t0 = await armHold(page);
      await drawStroke(page, path, { stepMs: 16 });
      await expect.poll(async () => markers(await elements(page)).length, { timeout: 15_000 }).toBe(1);
      await waitUntilWall(page, t0, 15_000);
      await releaseHold(page);
      await settled(page, 3);

      await expect
        .poll(async () => joined(await elements(page)), { timeout: 40_000 })
        .toMatch(/화이트보드|목표/);

      const els = await elements(page);
      const expected = sceneBBox(view, path);
      const text = finalTexts(els)[0]!;
      expect(finalTexts(els).length, "one text, where the line was").toBe(1);
      expect(markers(els).length, "the line marker left with the transcript").toBe(0);
      expect(text.containerId, "line text is free, not bound").toBeNull();
      expect(text.fontSize ?? 0, "legible floor").toBeGreaterThanOrEqual(DEFAULT_SETTINGS.lineMinFontSize);
      expect(text.width, "wrapped to the line, not spilling past its ends").toBeLessThanOrEqual(122);
      expect(text.text ?? "", "wrapped onto several lines").toContain("\n");
      expect(text.y + text.height, "sits where the line's upper side was").toBeLessThanOrEqual(expected.y + 2);
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
      const view = await transform(page);
      const path = oval({ x: 700, y: 420 }, 20);
      const region = sceneBBox(view, path);
      const t0 = await armHold(page);
      await drawStroke(page, path, { stepMs: 16 });
      await waitUntilWall(page, t0, 4_500);
      await releaseHold(page);

      await expect
        .poll(async () => texts(await elements(page)).map((el) => el.text ?? "").join(" "), {
          timeout: 30_000,
        })
        .toContain("⚠ STT");
      expect((await status(page)).failed).toBe(1);
      const failedEls = await elements(page);
      const failedMarker = markers(failedEls)[0]!;
      expect(failedMarker, "a failed region KEEPS its marker: the retry needs a visible target").toBeTruthy();
      expect(failedMarker.strokeStyle, "and it is still dashed").toBe("dashed");
      expect(texts(failedEls).find((el) => (el.text ?? "").includes("STT"))?.containerId).toBe(failedMarker.id);
      await evidence(page, "g5a-failure");

      await setSettings(page, { sttUrl: STT_URL });
      await page.evaluate(() => window.__excalidrawVoice!.controller.retryFailed());

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);
      await expect.poll(async () => (await status(page)).failed, { timeout: 10_000 }).toBe(0);
      const retried = await elements(page);
      expect(markers(retried).length, "a successful retry removes the marker like any commit").toBe(0);
      expect(retried.length, "only the transcript is left").toBe(1);
      const text = finalTexts(retried)[0]!;
      expect(text.containerId).toBeNull();
      expect(insideBox(text, region), `text ${JSON.stringify(text)} in ${JSON.stringify(region)}`).toBe(true);
      await evidence(page, "g5a-failure-retry");
    } finally {
      await browser.close();
    }
  });

  test("G5b failure: silence leaves nothing behind and says so", async () => {
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

      // Gate N10: the drop is rendered, not only counted. The library's own Toast is the sink — without it a
      // silent room and a mic that heard nothing look identical, because a discard leaves no ⚠ and no retry.
      await expect(page.locator(".Toast .Toast__message")).toHaveText("No speech heard for that shape", {
        timeout: 15_000,
      });

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
      expect(markers(els).length, "the region marker goes with the placeholder").toBe(0);
      expect(texts(els).length).toBe(0);
      expect(els.length, "a take that heard nothing leaves the canvas exactly as it was").toBe(0);
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
      const ids = [markers(doomed)[0]!.id, texts(doomed)[0]!.id];
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
      expect(markers(els).length).toBe(0);
      expect(els.length).toBe(0);
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

      const view = await transform(page);
      const path = oval({ x: 1000, y: 500 }, 20);
      const region = sceneBBox(view, path);
      const t0 = await armHold(page);
      await drawStroke(page, path, { stepMs: 16 });
      await waitUntilWall(page, t0, 4_500);
      await releaseHold(page);
      // The seeded note is also a transcript-shaped text, so the assertion follows the REGION the stroke drew.
      await expect
        .poll(async () => wordsIn(await elements(page), region), { timeout: 30_000 })
        .toMatch(/voice/i);
      const withVoice = await elements(page);
      const spoken = textIn(withVoice, region)!;
      expect(markers(withVoice).length, "the region marker is gone before the reload").toBe(0);

      // Give the 300 ms debounce a chance before the reload races it (beforeunload flushes anyway).
      await page.waitForTimeout(600);
      await page.reload();
      await waitForVoiceReady(page);
      const after = await elements(page);
      expect(after.map((el) => el.id)).toEqual(
        expect.arrayContaining(["seed-rect-00000000001", "seed-text-00000000001", spoken.id]),
      );
      // A free text has no container to be re-laid-out against, and the sweep must not touch it: same text, same
      // box, same place on the board after a reload.
      const reloaded = after.find((el) => el.id === spoken.id)!;
      expect(reloaded.text).toBe(spoken.text);
      expect(reloaded.containerId, "still free text").toBeNull();
      expect(reloaded.x).toBeCloseTo(spoken.x, 1);
      expect(reloaded.y).toBeCloseTo(spoken.y, 1);
      expect(reloaded.width).toBeCloseTo(spoken.width, 1);
      expect(reloaded.height).toBeCloseTo(spoken.height, 1);
      expect(reloaded.fontSize).toBe(spoken.fontSize);
      expect(insideBox(reloaded, region), "and still inside the region it was spoken into").toBe(true);
      await evidence(page, "g6-continuity");
    } finally {
      await browser.close();
    }
  });

  test("native tool modifier: a rectangle drawn with the native tool marks the region and vanishes", async () => {
    const { browser, page } = await launchWithClip(EN_SHORT);
    try {
      const view = await transform(page);
      await page.locator('[data-testid="toolbar-rectangle"]').click();
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
        .poll(async () => markers(await elements(page)).length, { timeout: 15_000 })
        .toBe(1);

      // The rectangle the founder drew with the native tool IS the marker: stamped, dashed, still its own size.
      const pending = await elements(page);
      const marker = markers(pending)[0]!;
      expect(marker.type).toBe("rectangle");
      expect(marker.strokeStyle).toBe("dashed");
      expect(Math.abs(marker.width - 300)).toBeLessThanOrEqual(3);
      expect(Math.abs(marker.height - 150)).toBeLessThanOrEqual(3);

      await waitUntilWall(page, t0, 4_500);
      await releaseHold(page);

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);
      const els = await elements(page);
      const region = sceneBBox(view, [{ x: 500, y: 300 }, { x: 800, y: 450 }]);
      expect(markers(els).length, "a native-tool region is a region: it goes with the commit").toBe(0);
      expect(shapes(els, "rectangle").length).toBe(0);
      expect(finalTexts(els).length).toBe(1);
      const text = finalTexts(els)[0]!;
      expect(text.containerId).toBeNull();
      expect(insideBox(text, region, 3), `text ${JSON.stringify(text)} in ${JSON.stringify(region)}`).toBe(true);
      await evidence(page, "native-tool-modifier");
    } finally {
      await browser.close();
    }
  });

  test("toolbar latch: tapping the voice tool arms and disarms it, and the glyph shows what the mic hears", async () => {
    const { browser, page } = await launchWithClip(EN_SHORT);
    try {
      const button = page.locator('[data-testid="toolbar-voice"]');

      // Idle is a static outline: nothing is being heard, and nothing pretends to be (round 4b request 2).
      const cold = await micGlyph(page);
      expect(cold, "idle glyph").toEqual({ armed: false, speaking: false, level: 0 });

      await button.click();
      await expect.poll(async () => (await status(page)).mode, { timeout: 10_000 }).toBe("latched");
      await expect(button).toHaveClass(/voice-tool--armed/);
      await page.waitForFunction(() => window.__excalidrawVoice!.status().recording === true, undefined, {
        timeout: 15_000,
      });
      // The fixture starts playing at the arm, so the sampler has to be running before the speech does.
      await watchMicGlyph(page);

      const view = await transform(page);
      const path = oval({ x: 700, y: 450 }, 20);
      const region = sceneBBox(view, path);
      await drawStroke(page, path, { stepMs: 16 });
      await page.waitForTimeout(4_000);

      // While armed the capsule filled and the accent came on: the fill is proportional to the level and the accent
      // is the VAD's own verdict, so together they are the "your voice is being recognised" signal.
      const heard = await readMicGlyphWatch(page);
      expect(heard.samples, "the in-page sampler ran").toBeGreaterThan(20);
      expect(heard.peakLevel, "the mic capsule filled while the clip played").toBeGreaterThan(0);
      expect(heard.sawSpeaking, "the accent came on while an utterance was open").toBe(true);
      /*
       * Founder request 2 is "reacts to the volume", not "blinks": on the settings meter's 0.06 axis ordinary speech
       * pinned --voice-level at 1.00 and only dropped in the gaps between words, so the glyph strobed. The glyph has
       * its own compressed axis now (level.ts glyphLevel), and this is what tells the two apart.
       */
      const partial = new Set(
        heard.levels.filter((v) => v > 0.02 && v < 0.98).map((v) => v.toFixed(2)),
      );
      expect(
        partial.size,
        `the capsule tracked the volume rather than toggling (levels: ${heard.levels.slice(0, 40).join(",")})`,
      ).toBeGreaterThanOrEqual(3);
      await evidence(page, "round4b-glyph-armed");

      await button.click();
      await expect.poll(async () => (await status(page)).mode, { timeout: 10_000 }).toBe("idle");
      // Back to a static outline: a disarmed tool must not keep showing the last level it saw.
      await expect
        .poll(async () => await micGlyph(page), { timeout: 10_000 })
        .toEqual({ armed: false, speaking: false, level: 0 });

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);
      const latched = await elements(page);
      expect(markers(latched).length, "a latched take ends the same way a held one does").toBe(0);
      expect(wordsIn(latched, region), "the words are inside the region that was drawn").toMatch(/voice/i);
      await expect(button).not.toHaveClass(/voice-tool--armed/);
      await evidence(page, "toolbar-latch");
    } finally {
      await browser.close();
    }
  });

  test("settings live in the main menu: no gear, nothing lost from the vanilla menu, ko/en only", async () => {
    const { browser, page } = await launchWithClip(EN_SHORT);
    try {
      // Founder request 3: the top-right gear is gone, not merely duplicated.
      await expect(page.locator('[data-testid="voice-settings-gear"]')).toHaveCount(0);
      await expect(page.locator(".voice-settings")).toHaveCount(0);

      await page.locator('[data-testid="main-menu-trigger"]').click();
      /*
       * In the wrapper this gate existed because rendering our own <MainMenu> REPLACED the library's fallback one
       * and a forgotten item would disappear silently. In excalidraw-app the menu is the APP's own composition
       * (excalidraw-app/components/AppMainMenu.tsx) and the voice entry is one item added to it — so the same list
       * now asserts that adding it cost the founder none of the rows they already had: Open, Export, Export image,
       * Find, Help, Reset the canvas, dark mode, canvas background — plus ours.
       *
       * `SaveToActiveFile` is rendered but deliberately not asserted: the library returns null for it until the
       * scene has a file handle, so it is absent on a fresh boot too. (The visible "Save to…" row is
       * `Export`/json-export-button, which IS asserted.) Gating on it would gate on the File System Access API,
       * not on the composition.
       */
      for (const testid of [
        "load-button",
        "json-export-button",
        "image-export-button",
        "search-menu-button",
        "help-menu-item",
        "clear-canvas-button",
        "canvas-background-label",
        "menu-voice-settings",
      ]) {
        await expect(page.locator(`[data-testid="${testid}"]`), testid).toHaveCount(1);
      }
      /*
       * The theme row is the one item whose SHAPE differs from the wrapper's menu, not just its position: the app
       * passes `allowSystemTheme` to MainMenu.DefaultItems.ToggleTheme, which renders a light/dark/system radio
       * group (components/RadioGroup.tsx) instead of the single `toggle-dark-mode` item the 0.18.1 fallback had.
       * Same row, same place, three choices — so the gate asserts the control, not the old testid.
       */
      await expect(page.locator('input[name="theme"]'), "theme control").toHaveCount(3);
      await evidence(page, "round4b-main-menu");

      await page.locator('[data-testid="menu-voice-settings"]').click();
      const panel = page.locator('[role="dialog"][aria-label="Voice settings"]');
      await expect(panel).toBeVisible();

      // Founder request 4: ja/zh are gone from the only surface that can select them.
      const options = panel
        .locator(".voice-settings__row", { hasText: "Language" })
        .locator("select option");
      expect(await options.evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))).toEqual([
        "",
        "ko",
        "en",
      ]);
      await evidence(page, "round4b-menu-settings");

      // The panel moved, the F9 guard did not: a key pressed inside one of its fields must not arm the tool
      // (App.isPanelInput), or editing the STT URL would record the room.
      await panel.locator('input[type="text"]').first().focus();
      await page.keyboard.press("F9");
      await page.waitForTimeout(300);
      expect((await status(page)).mode, "F9 inside a panel field arms nothing").toBe("idle");

      /*
       * Round 4c: the panel is rendered OUTSIDE the .excalidraw subtree, where the library's `--color-*` variables
       * resolve to nothing — the level meter drew an empty track at 100%, the buttons were white-on-transparent and
       * the inputs lost their borders entirely (an invalid `border` shorthand falls back to border-style none). The
       * wall panel has no console, so "invisible control" is indistinguishable from "broken app": gate the paint.
       */
      const painted = await panel.evaluate((el) => {
        const px = (node: Element | null) => (node ? getComputedStyle(node) : null);
        const fill = px(el.querySelector(".voice-meter__fill"));
        const action = px(el.querySelector(".voice-settings__actions button"));
        const input = px(el.querySelector(".voice-settings__row input"));
        return {
          scoped: el.closest(".excalidraw") !== null,
          meterFill: fill?.backgroundColor ?? "",
          buttonBackground: action?.backgroundColor ?? "",
          inputBorder: `${input?.borderStyle ?? ""} ${input?.borderWidth ?? ""}`.trim(),
        };
      });
      expect(painted.meterFill, "the level bar has to be drawn in something").not.toBe("rgba(0, 0, 0, 0)");
      expect(painted.buttonBackground, "Test STT / Close are white text: they need their chip").not.toBe(
        "rgba(0, 0, 0, 0)",
      );
      expect(painted.inputBorder, "an input with no border is not visibly an input").toBe("solid 1px");

      // Stylus only, no keyboard: a tap on the canvas has to be a way out of the panel.
      await page.mouse.click(1200, 700);
      await expect(panel, "a tap outside closes the panel").toBeHidden();
      await page.locator('[data-testid="main-menu-trigger"]').click();
      await page.locator('[data-testid="menu-voice-settings"]').click();
      await expect(panel).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(panel, "and so does Escape, for whoever has a keyboard").toBeHidden();
      expect(
        (await elements(page)).length,
        "and the tap that closed it drew nothing on the board",
      ).toBe(0);
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
      expect(els.length, "three transcripts, nothing else: every marker has left").toBe(3);
      await evidence(page, "n6c-palm-tap");
    } finally {
      await browser.close();
    }
  });

  test("N2a boundary: a zero-gap stroke pair produces two regions, both written", async () => {
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
      expect(markers(els).length, "both regions committed and cleaned up after themselves").toBe(0);
      expect(finalTexts(els).length, "exactly one transcript per stroke").toBe(2);
      const a = nearestText(els, { x: 420, y: 300 })!;
      const b = nearestText(els, { x: 1080, y: 300 })!;
      expect(a.id).not.toBe(b.id);
      expect(flat(a.text ?? ""), "first region kept the first sentence").toMatch(/회의/);
      expect(flat(b.text ?? ""), "second region kept what followed").toMatch(/voice/i);
      expect(flat(a.text ?? "")).not.toMatch(/voice/i);
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
      expect(markers(els).length, "the region was written and its marker removed").toBe(0);
      expect(finalTexts(els).length, "one transcript, from the stroke that nearly got lost").toBe(1);
      expect(flat(finalTexts(els)[0]!.text ?? ""), "the speech in flight still landed").not.toBe("");
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
      await expect.poll(async () => markers(await elements(page)).length, { timeout: 15_000 }).toBe(1);

      await page.keyboard.press("Control+z");
      // The undo of the marker step restores the raw freedraw stroke: the marker and its placeholder go away.
      await expect.poll(async () => markers(await elements(page)).length, { timeout: 10_000 }).toBe(0);
      const undone = await elements(page);
      expect(shapes(undone, "freedraw").length, "A is ink again").toBe(1);
      expect(texts(undone).length, "A's placeholder went with it").toBe(0);

      await drawStroke(page, oval(bCenter, 14), { stepMs: 14 });
      await expect.poll(async () => markers(await elements(page)).length, { timeout: 15_000 }).toBe(1);

      const els = await elements(page);
      const marker = markers(els)[0]!;
      expect(Math.abs(marker.x + marker.width / 2 - bCenter.x), "the marker is at B").toBeLessThanOrEqual(4);
      expect(Math.abs(marker.y + marker.height / 2 - bCenter.y)).toBeLessThanOrEqual(4);
      expect(marker.strokeStyle).toBe("dashed");
      const placeholders = texts(els).filter(isPlaceholder);
      expect(placeholders.length, "exactly one placeholder, B's").toBe(1);
      expect(placeholders[0]!.containerId).toBe(marker.id);
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
      await expect.poll(async () => markers(await elements(page)).length, { timeout: 15_000 }).toBe(1);

      // Ctrl+Z while the sentence is still being spoken: the marker pair leaves the scene mid-utterance.
      await page.keyboard.press("Control+z");
      await expect.poll(async () => markers(await elements(page)).length, { timeout: 10_000 }).toBe(0);
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
      expect(placed[0]!.containerId, "free text, not bound to the region the founder undid").toBeNull();
      expect(markers(els).length, "the undone region stays undone").toBe(0);
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
      expect(markers(els).length, "no region was marked, so the ink is just ink").toBe(0);
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
        const marker = markers(els)[0];
        expect(marker, `a region marker at zoom ${zoom}`).toBeTruthy();
        expect(markers(els).length, `one marker at zoom ${zoom}`).toBe(1);
        expect(marker!.type, `the marker is the region's box at zoom ${zoom}`).toBe("rectangle");
        expect(marker!.width, `scene width at zoom ${zoom}`).toBeCloseTo(300 / zoom, 0);
        expect(marker!.height, `scene height at zoom ${zoom}`).toBeCloseTo(160 / zoom, 0);
        expect(Math.abs(marker!.x - expectedBox.x), `scene x at zoom ${zoom}`).toBeLessThanOrEqual(2);
        expect(shapes(els, "freedraw").length, `the tap left no ink at zoom ${zoom}`).toBe(0);
        expect(els.length, `only the marker and its placeholder at zoom ${zoom}`).toBe(2);
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

  test("R3 ghosts: a reload deletes the markers and placeholders a take left behind", async () => {
    // Three seeded cases in one scene: the region marker a reload stranded (with its placeholder), a plain shape
    // the founder drew themselves, and a pre-round-4a container that still holds a ghost label.
    const base = (id: string, extra: Record<string, unknown>) => ({
      id,
      x: 400,
      y: 260,
      width: 260,
      height: 140,
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
      seed: 123_456_789,
      version: 7,
      versionNonce: 987_654_321,
      isDeleted: false,
      boundElements: null,
      updated: 1_726_000_000_000,
      link: null,
      locked: false,
      ...extra,
    });
    const ghostText = (id: string, containerId: string | null, extra: Record<string, unknown>) =>
      base(id, {
        type: "text",
        width: 24,
        height: 35,
        text: "··",
        originalText: "··",
        fontSize: 28,
        fontFamily: 5,
        textAlign: "center",
        verticalAlign: "middle",
        containerId,
        lineHeight: 1.25,
        autoResize: true,
        ...extra,
      });
    const seeded = [
      base("marker-rect-000000001", {
        type: "rectangle",
        strokeStyle: "dashed",
        index: "a0",
        customData: { voiceRegion: true },
        boundElements: [{ id: "marker-text-000000001", type: "text" }],
      }),
      ghostText("marker-text-000000001", "marker-rect-000000001", { x: 500, y: 310, index: "a1" }),
      base("marker-line-000000001", {
        type: "line",
        x: 900,
        y: 700,
        width: 200,
        height: 0,
        points: [[0, 0], [200, 0]],
        strokeStyle: "dashed",
        index: "a2",
        customData: { voiceRegion: true },
      }),
      ghostText("marker-line-text-00001", null, { x: 960, y: 660, index: "a3" }),
      base("mine-rect-00000000001", { type: "rectangle", x: 200, y: 700, index: "a4" }),
      base("legacy-rect-000000001", {
        type: "rectangle",
        x: 1200,
        y: 200,
        strokeStyle: "dashed",
        index: "a5",
        boundElements: [{ id: "legacy-text-000000001", type: "text" }],
      }),
      ghostText("legacy-text-000000001", "legacy-rect-000000001", { x: 1300, y: 250, index: "a6" }),
    ];
    const { browser, page } = await launchWithClip(`${ensureSilenceClip()}%noloop`, {
      seed: { excalidraw: JSON.stringify(seeded) },
    });
    try {
      const els = await elements(page);
      const byId = (id: string) => els.find((el) => el.id === id);

      expect(markers(els), "no region marker survives a reload: nothing can finish that take").toHaveLength(0);
      expect(byId("marker-rect-000000001"), "the stranded rectangle marker is gone").toBeUndefined();
      expect(byId("marker-text-000000001"), "and so is its placeholder").toBeUndefined();
      expect(byId("marker-line-000000001"), "the stranded line marker is gone").toBeUndefined();
      expect(byId("marker-line-text-00001"), "and its unbound placeholder with it").toBeUndefined();
      expect(texts(els).some((el) => isPlaceholder(el)), "no placeholder text is left").toBe(false);

      const mine = byId("mine-rect-00000000001");
      expect(mine, "a shape the founder drew is not a marker and is never swept").toBeTruthy();
      expect(mine!.strokeStyle).toBe("solid");
      expect(mine!.width).toBe(260);

      // A container from before round 4a: the founder's shape stays, only the ghost label is cleaned off it.
      const legacy = byId("legacy-rect-000000001");
      expect(legacy, "the founder's pre-4a shape survives the sweep").toBeTruthy();
      expect(legacy!.strokeStyle, "the pending cue is gone").toBe("solid");
      expect(legacy!.boundElements ?? [], "the ghost is unbound").toHaveLength(0);
      expect(byId("legacy-text-000000001"), "the ghost text is gone").toBeUndefined();
      await evidence(page, "r3-ghost-sweep");
    } finally {
      await browser.close();
    }
  });

  /**
   * ROUND 5 — the founder's complaint, measured on the real surface.
   *
   *   "I wish speech recognition didn't make you wait until after you finish drawing the region. Instead, it
   *    should happen at the same time while you're selecting the area."
   *
   * The cause was structural: the STT request was only ever sent from the assignment path, and that path is held
   * by the pre-roll window AND by the pen-down flush barrier (gate N2e). So the whole GPU round trip was paid
   * after pen-up. These three cases measure the two halves separately — the words arrive the instant the region
   * exists (R5a), they start appearing before the speaker has even stopped (R5b), and a preview shown in the
   * region the pre-roll had not yet decided against is given back (R5c).
   */
  test("R5a speak-then-draw lands the instant the region exists", async () => {
    const { browser, page } = await launchWithClip(KO_SHORT);
    try {
      await recordUtterances(page);
      const t0 = await armHold(page);

      // The rhythm the complaint describes: the label is spoken, and the region is drawn around it while the words
      // are still being said. The pen keeps moving — a careful oval traced on a wall panel — until the transcript
      // is in hand, which is the state the whole round is about: the words waiting for the region rather than the
      // region waiting for the words. Written as a poll rather than a tuned sleep so the gate does not depend on
      // the server's round trip of the day (measured 0.6–1.7 s over the tailnet).
      await waitUntilWall(page, t0, 500);
      await watchWords(page);
      const path = oval({ x: 700, y: 450 }, 12);
      await page.mouse.move(path[0]!.x, path[0]!.y);
      await page.mouse.down();
      const deadline = Date.now() + 20_000;
      let step = 1;
      let inHand: Awaited<ReturnType<typeof status>> | null = null;
      while (Date.now() < deadline) {
        const p = path[step % path.length]!;
        step += 1;
        await page.mouse.move(p.x, p.y);
        await page.waitForTimeout(90);
        const now = await status(page);
        if (now.lastSttLatencyMs !== undefined && now.pending === 0) {
          inHand = now;
          break;
        }
      }
      expect(inHand, "the transcript came back while the pen was still on the panel").not.toBeNull();
      expect(inHand!.completed, "and nothing is on the canvas yet: the region is not finished").toBe(0);
      expect(step, `the stroke was still being drawn after ${step} samples`).toBeGreaterThan(2);
      await page.mouse.up();

      // THE MEASUREMENT: pen-up → the words on the canvas, both timestamps taken inside the page.
      await expect.poll(async () => (await readWords(page)).committed !== null, { timeout: 30_000 }).toBe(true);
      const words = await readWords(page);
      await stopWords(page);
      const penUpToWords = words.committed!.at - words.upAt;
      const s = await status(page);
      const seen = await seenUtterances(page);
      console.log(
        `[R5a] pen-up -> words: ${penUpToWords} ms | STT round trip: ${Math.round(s.lastSttLatencyMs ?? 0)} ms` +
          ` | utterance ${seen[0]?.onsetMs}..${seen[0]?.endMs} (capture clock) | "${words.committed!.text}"`,
      );
      expect(words.upAt, "the pointer-up was seen inside the page").toBeGreaterThan(0);
      expect(s.lastSttLatencyMs, "the round trip really happened").toBeGreaterThan(50);
      // Before round 5 this was the round trip itself plus the conversion (~1 s measured); now it is the
      // conversion alone, because the transcript was already in hand when the pen came up.
      expect(
        penUpToWords,
        `pen-up -> words ${penUpToWords} ms must not contain the ${Math.round(s.lastSttLatencyMs ?? 0)} ms round trip`,
      ).toBeLessThanOrEqual(400);

      await releaseHold(page);
      const els = await elements(page);
      expect(markers(els).length, "the region marker left with its transcript").toBe(0);
      expect(finalTexts(els).length, "exactly one transcript on the canvas").toBe(1);
      expect(finalTexts(els)[0]!.text, "and it is the Korean label, not an orphan somewhere else").toMatch(/회의|안건|정리/);
      expect(s.orphans, "the words went into the region, not to the pen origin").toBe(0);
      await evidence(page, "r5a-lands-when-the-region-exists");
    } finally {
      await browser.close();
    }
  });

  test("R5b interim text appears while still speaking", async () => {
    const { browser, page } = await launchWithClip(koLongOpen());
    try {
      await recordUtterances(page);
      const t0 = await armHold(page);
      await watchWords(page);
      // Region first: this case is about WHEN the words appear, not about which region gets them.
      const path = oval({ x: 700, y: 430 }, 16);
      const region = sceneBBox(await transform(page), path);
      await drawStroke(page, path, { stepMs: 14 });

      // ko-long is one 5.4 s utterance, so a preview has time to come back long before the VAD closes it.
      await expect.poll(async () => (await readWords(page)).interim !== null, { timeout: 30_000 }).toBe(true);
      const shown = (await readWords(page)).interim!;
      console.log(
        `[R5b] interim at capture ${Math.round(shown.captureNow)} ms, speaking=${shown.speaking},` +
          ` opacity=${shown.opacity}: "${shown.text}"`,
      );
      expect(shown.speaking, "the founder is still talking when the words show up").toBe(true);
      expect(shown.text.length, "and they are words, not a placeholder dot").toBeGreaterThan(0);
      expect(shown.opacity, "drawn faint, so it reads as not settled yet").toBeLessThan(100);

      const pendingEls = await elements(page);
      const preview = texts(pendingEls).find((el) => el.customData?.voiceInterim === true)!;
      expect(preview, "the preview is stamped, so a reload sweeps it").toBeTruthy();
      expect(markers(pendingEls).length, "the region marker is still there: the take is not over").toBe(1);
      await evidence(page, "r5b-interim-while-speaking");

      await waitUntilWall(page, t0, 9_500);
      await releaseHold(page);
      await settled(page, 1);

      const seen = await seenUtterances(page);
      expect(
        shown.captureNow,
        `the preview (${Math.round(shown.captureNow)}) appeared before the utterance ended (${seen[0]?.endMs})`,
      ).toBeLessThan(seen[0]!.endMs!);

      const els = await elements(page);
      const committed = textIn(els, region, 4)!;
      expect(committed, "the final transcript replaced the preview").toBeTruthy();
      expect(committed.id, "in the very same element").toBe(preview.id);
      expect(committed.customData?.voiceInterim, "with the interim stamp cleared").toBeUndefined();
      expect(committed.text!.trim().length).toBeGreaterThan(0);
      expect(markers(els).length, "and the marker is gone").toBe(0);
      await evidence(page, "r5b-final-replaces-interim");
    } finally {
      await browser.close();
    }
  });

  test("R5c provisional region corrected by the final assignment", async () => {
    /**
     * HARNESS-BENT PARAMETERS, named on purpose (RETRO vocabulary). `interimMs` is dropped to 400 and `preRollMs`
     * raised to 6000 because at the shipped defaults this case is UNREACHABLE: the pre-roll window closes 1.5 s
     * after the onset, and the measured round trip (~1.6 s over the tailnet) cannot put a preview on the canvas and
     * still leave the founder time to draw the region they actually meant. So at defaults the provisional region is
     * almost always the final one — which is both the reason the revert path needs a gate and the reason the gate
     * needs bent settings to exist.
     */
    const { browser, page } = await launchWithClip(koLongOpen(), {
      settings: { interimMs: 400, preRollMs: 6000 },
    });
    try {
      await recordUtterances(page);
      const t0 = await armHold(page);
      const view = await transform(page);

      // Region A is drawn first, so it is the only candidate while the speech starts: the preview goes there.
      const pathA = oval({ x: 400, y: 260 }, 10);
      const boxA = sceneBBox(view, pathA);
      await drawStroke(page, pathA, { stepMs: 12 });
      await watchWords(page);
      await expect.poll(async () => (await readWords(page)).interim !== null, { timeout: 30_000 }).toBe(true);
      const previewEls = await elements(page);
      const previewA = texts(previewEls).find((el) => el.customData?.voiceInterim === true)!;
      expect(insideBox(previewA, boxA, 4), "the preview borrowed region A").toBe(true);
      console.log(`[R5c] preview in region A: "${previewA.text}"`);
      await evidence(page, "r5c-preview-in-region-a");

      // Then the region the founder actually meant, still inside the (bent) pre-roll window: assign.ts gives the
      // words to the LATER stroke, so A has to be handed back exactly as it was found.
      const pathB = oval({ x: 1100, y: 600 }, 10);
      const boxB = sceneBBox(view, pathB);
      await drawStroke(page, pathB, { stepMs: 12 });

      // Still ARMED: region A is examined before the disarm sweep gets to it, because "a region nobody spoke into"
      // is removed at the end of the take (round 4c) and that would hide whether it had been handed back intact.
      // `wordsIn` reads the COMMITTED texts only (finalTexts skips the interim stamp), so this waits for the final
      // transcript in B and not for the preview that moved there when B became the provisional owner.
      await expect
        .poll(async () => wordsIn(await elements(page), boxB, 4), { timeout: 40_000 })
        .toMatch(/회의|목표|음성|화이트보드|인식/);
      const els = await elements(page);
      console.log(
        `[R5c] texts: ${texts(els)
          .map((el) => `"${flat(el.text ?? "")}"@${Math.round(el.x)},${Math.round(el.y)}`)
          .join(" ")} | A=${JSON.stringify(boxA)} B=${JSON.stringify(boxB)}`,
      );
      expect(textIn(els, boxA, 4), "region A kept none of the words").toBeUndefined();
      const leftA = texts(els).find((el) => insideBox(el, boxA, 8));
      expect(leftA, "region A still has its own text element").toBeTruthy();
      expect(isPlaceholder(leftA!), "…back to the animated dot, not half a sentence").toBe(true);
      expect(leftA!.customData?.voiceInterim, "with the interim stamp cleared").toBeUndefined();
      expect(markers(els).length, "and region A is still on the canvas: it is the founder's until the take ends").toBe(1);
      await evidence(page, "r5c-region-a-reverted");

      await waitUntilWall(page, t0, 10_500);
      await releaseHold(page);
      await settled(page, 1);
      const after = await elements(page);
      expect(markers(after).length, "the disarm then sweeps the region nothing was said into").toBe(0);
      expect(finalTexts(after).length, "one transcript on the canvas, in region B").toBe(1);
    } finally {
      await browser.close();
    }
  });
});
