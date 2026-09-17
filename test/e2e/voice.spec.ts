/**
 * Real-surface proof for the voice tool: a real browser, Chromium's fake microphone fed with real speech WAVs,
 * and the founder's real STT server. Nothing here is mocked, so every assertion is about the shipped bundle.
 *
 * One browser per test (the clip is a launch flag) and one screenshot per gate under test-results/evidence/.
 */
import { expect, test } from "@playwright/test";

import type { StyleSnapshot } from "../../src/contracts";
import {
  armHold,
  drawStroke,
  elements,
  ellipsePath,
  ensureDenseClip,
  ensureSilenceClip,
  evidence,
  fixture,
  isPlaceholder,
  launchWithClip,
  linePath,
  releaseHold,
  sceneBBox,
  setSettings,
  shapes,
  status,
  texts,
  transcriptTexts,
  transform,
  waitForVoiceReady,
  type SceneEl,
} from "./helpers";

const STT_URL = "http://100.81.33.83:8770";
/** "⚠ STT" is a transcript-shaped text that is not a transcript; keep it out of the transcript assertions. */
const finalTexts = (els: SceneEl[]): SceneEl[] =>
  transcriptTexts(els).filter((el) => !(el.text ?? "").includes("STT"));
const joined = (els: SceneEl[]): string => finalTexts(els).map((el) => el.text ?? "").join(" | ");

test.describe("voice areas", () => {
  test("G1 vertical slice: one stroke + speech becomes a filled ellipse", async () => {
    const { browser, page } = await launchWithClip(fixture("jfk.wav"));
    try {
      const view = await transform(page);
      const path = ellipsePath(700, 450, 150, 80, 32);
      const expected = sceneBBox(view, path);

      await armHold(page);
      await drawStroke(page, path);
      await expect
        .poll(async () => shapes(await elements(page), "ellipse").length, { timeout: 15_000 })
        .toBe(1);
      // jfk.wav is 11 s and LOOPS: holding longer than one loop puts the whole sentence in this one segment.
      await page.waitForTimeout(12_500);
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

  test("G2 parallelism: three strokes in one hold, transcripts overlap", async () => {
    const { browser, page } = await launchWithClip(ensureDenseClip());
    try {
      await armHold(page);
      const spots = [
        ellipsePath(450, 260, 110, 70, 12),
        ellipsePath(950, 260, 110, 70, 12),
        ellipsePath(700, 600, 110, 70, 12),
      ];
      for (const spot of spots) {
        await drawStroke(page, spot, 16);
        // ~1 s from pointer-down to pointer-down (the segment boundary) while speech keeps flowing: short
        // enough that the previous segment's ~1.5 s round trip is still in flight when the next one starts.
        await page.waitForTimeout(600);
      }
      await releaseHold(page);

      await expect
        .poll(async () => (await status(page)).maxPendingSeen, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(2);
      await expect.poll(async () => (await status(page)).completed, { timeout: 30_000 }).toBe(3);

      const els = await elements(page);
      expect(shapes(els, "ellipse").length).toBe(3);
      const bound = finalTexts(els);
      expect(bound.length).toBe(3);
      for (const text of bound) {
        expect((text.text ?? "").trim().length).toBeGreaterThan(0);
        expect(shapes(els, "ellipse").some((el) => el.id === text.containerId)).toBe(true);
      }
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
        const tap = [
          { x: 50, y: 50 },
          { x: 52, y: 51 },
          { x: 53, y: 52 },
        ];
        return {
          circle: recognize(circle),
          box: recognize(box),
          line: recognize(line),
          vertical: recognize(vertical),
          tap: recognize(tap),
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
          const run = (transcript: string) => {
            const placeholder = voice.fit.buildPlaceholder(
              { kind: "rectangle", x: 100, y: 100, width: 240, height: 120 },
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
          return { en: run(en), ko: run(ko) };
        },
        { en: english, ko: korean },
      );

      for (const [label, m] of Object.entries(measured)) {
        expect(m.width, `${label} width`).toBeCloseTo(240, 0);
        expect(m.height, `${label} height`).toBeCloseTo(120, 0);
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
    const { browser, page } = await launchWithClip(fixture("en-short.wav"));
    try {
      const view = await transform(page);
      const path = linePath({ x: 450, y: 600 }, { x: 850, y: 600 }, 16);
      await armHold(page);
      await drawStroke(page, path);
      await expect.poll(async () => shapes(await elements(page), "line").length, { timeout: 15_000 }).toBe(1);
      // en-short.wav is 2.4 s and loops; 5 s of hold contains at least one complete utterance.
      await page.waitForTimeout(5_000);
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
    const { browser, page } = await launchWithClip(fixture("en-short.wav"));
    try {
      const path = linePath({ x: 450, y: 620 }, { x: 750, y: 740 }, 16);
      await armHold(page);
      await drawStroke(page, path);
      await expect.poll(async () => shapes(await elements(page), "line").length, { timeout: 15_000 }).toBe(1);
      await page.waitForTimeout(5_000);
      await releaseHold(page);

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);

      const els = await elements(page);
      const text = finalTexts(els)[0]!;
      expect(text.angle).toBeCloseTo(Math.atan2(120, 300), 1);
      expect(Math.abs(text.angle - Math.atan2(120, 300))).toBeLessThan(0.05);
      await evidence(page, "g4c-line-slanted");
    } finally {
      await browser.close();
    }
  });

  test("G5a failure: unreachable STT shows the warning, retry recovers the transcript", async () => {
    const { browser, page } = await launchWithClip(fixture("en-short.wav"));
    try {
      await setSettings(page, { sttUrl: "http://127.0.0.1:9" });
      await armHold(page);
      await drawStroke(page, ellipsePath(700, 420, 150, 90, 20));
      await page.waitForTimeout(4_000);
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
      await armHold(page);
      await drawStroke(page, ellipsePath(700, 420, 150, 90, 20));
      await expect.poll(async () => texts(await elements(page)).length, { timeout: 15_000 }).toBe(1);
      const placeholder = texts(await elements(page))[0]!;
      expect(isPlaceholder(placeholder)).toBe(true);
      await page.waitForTimeout(2_000);
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
      expect(ellipse).toBeTruthy();
      expect(ellipse.strokeStyle).toBe("solid");
      expect(texts(els).length).toBe(0);
      expect((await status(page)).failed).toBe(0);
      await evidence(page, "g5b-silence");
    } finally {
      await browser.close();
    }
  });

  test("G5c failure: deleting the shape while pending drops the result silently", async () => {
    const { browser, page } = await launchWithClip(fixture("en-short.wav"));
    try {
      await armHold(page);
      await drawStroke(page, ellipsePath(700, 420, 150, 90, 20));
      await page.waitForTimeout(1_500);
      await releaseHold(page);
      await expect.poll(async () => (await status(page)).pending, { timeout: 15_000 }).toBe(1);

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

      await expect.poll(async () => (await status(page)).pending, { timeout: 30_000 }).toBe(0);
      const final = await status(page);
      expect(final.failed).toBe(0);
      expect(final.completed).toBe(0);
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
    const { browser, page } = await launchWithClip(fixture("en-short.wav"), {
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

      await armHold(page);
      await drawStroke(page, ellipsePath(1000, 500, 140, 80, 20));
      await page.waitForTimeout(5_000);
      await releaseHold(page);
      // The seeded note is also a transcript-shaped text, so the assertion follows the CONTAINER binding.
      await expect
        .poll(
          async () => {
            const els = await elements(page);
            const container = shapes(els, "ellipse")[0];
            return container
              ? (finalTexts(els).find((el) => el.containerId === container.id)?.text ?? "")
              : "";
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
    const { browser, page } = await launchWithClip(fixture("en-short.wav"));
    try {
      await page.locator('label.ToolIcon:has([data-testid="toolbar-rectangle"])').click();
      await expect
        .poll(async () => page.evaluate(() => window.__excalidrawVoice!.api.getAppState().activeTool.type))
        .toBe("rectangle");

      await armHold(page);
      await page.mouse.move(500, 300);
      await page.mouse.down();
      for (let i = 1; i <= 12; i += 1) {
        await page.mouse.move(500 + (300 * i) / 12, 300 + (150 * i) / 12);
        await page.waitForTimeout(24);
      }
      await page.mouse.up();
      await page.waitForTimeout(200);
      await expect
        .poll(async () => shapes(await elements(page), "rectangle").length, { timeout: 15_000 })
        .toBe(1);
      await page.waitForTimeout(5_000);
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
    const { browser, page } = await launchWithClip(fixture("en-short.wav"));
    try {
      const button = page.locator('[data-testid="toolbar-voice"]');
      await button.click();
      await expect.poll(async () => (await status(page)).mode, { timeout: 10_000 }).toBe("latched");
      await expect(button).toHaveClass(/voice-tool--armed/);
      await page.waitForFunction(() => window.__excalidrawVoice!.status().recording === true, undefined, {
        timeout: 15_000,
      });

      await drawStroke(page, ellipsePath(700, 450, 150, 90, 20));
      await page.waitForTimeout(5_000);
      await button.click();
      await expect.poll(async () => (await status(page)).mode, { timeout: 10_000 }).toBe("idle");

      await expect.poll(async () => joined(await elements(page)), { timeout: 30_000 }).toMatch(/voice/i);
      const latched = await elements(page);
      const latchedContainer = shapes(latched, "ellipse")[0]!;
      expect(latchedContainer, "the stroke must have become a container").toBeTruthy();
      expect(finalTexts(latched)[0]!.containerId).toBe(latchedContainer.id);
      await expect(button).not.toHaveClass(/voice-tool--armed/);
      await evidence(page, "toolbar-latch");
    } finally {
      await browser.close();
    }
  });
});
