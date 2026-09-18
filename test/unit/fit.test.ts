/**
 * Round-4a gates for fit.ts: the drawn shape is a REGION MARKER, not a drawing.
 *
 * fit.ts is contracted to run in a browser because every measurement goes through the library's own text layout.
 * What is gated here is fit's OWN logic around that layout — which element becomes a marker, what it is stamped
 * with, that a commit frees the text and deletes the marker, that a second utterance can be fitted with no marker
 * left at all — so the library is replaced by a fake whose text metrics are a deterministic formula and whose
 * bound-text layout grows a too-small container exactly like `redrawTextBoundingBox` does. The real numbers are
 * proved in the browser (e2e G1/G4a); the rules are proved here, where every branch is reachable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Width of one character as a fraction of the font size, and line height as a multiple of it. */
const CHAR = 0.6;
const LINE_HEIGHT = 1.25;
/** The library's own BOUND_TEXT_PADDING. */
const PADDING = 5;

interface Label {
  text: string;
  fontSize: number;
  fontFamily: number;
  strokeColor?: string;
  opacity?: number;
  textAlign?: string;
  verticalAlign?: string;
}
interface Skeleton {
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  text?: string;
  fontSize?: number;
  label?: Label;
  points?: number[][];
}
type Built = Record<string, unknown> & { id: string; type: string };

let ids = 0;
const nextId = (): string => `fake-${(ids += 1)}`;

const measure = (text: string, fontSize: number): { width: number; height: number } => {
  const lines = text.split("\n");
  return {
    width: Math.max(...lines.map((line) => line.length)) * CHAR * fontSize,
    height: lines.length * LINE_HEIGHT * fontSize,
  };
};

/** Greedy wrap on spaces, like the library's own `wrapText` for the cases these tests feed it. */
const wrap = (text: string, fontSize: number, maxWidth: number): string => {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || measure(candidate, fontSize).width <= maxWidth) {
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.join("\n");
};

vi.mock("@excalidraw/excalidraw", () => ({
  ROUNDNESS: { ADAPTIVE_RADIUS: 3, PROPORTIONAL_RADIUS: 2 },
  newElementWith: (element: { version?: number }, updates: object) => ({
    ...element,
    ...updates,
    version: (element.version ?? 0) + 1,
  }),
  convertToExcalidrawElements: (skeletons: Skeleton[]): Built[] => {
    const out: Built[] = [];
    for (const skeleton of skeletons) {
      const { label, ...rest } = skeleton;
      const base = { ...rest, id: nextId(), isDeleted: false, version: 1, angle: rest.angle ?? 0 } as Built;
      if (skeleton.type === "text") {
        const content = skeleton.text ?? "";
        out.push({
          ...base,
          text: content,
          originalText: content,
          containerId: null,
          autoResize: true,
          lineHeight: LINE_HEIGHT,
          textAlign: "left",
          verticalAlign: "top",
          ...measure(content, skeleton.fontSize ?? 20),
        });
        continue;
      }
      if (!label) {
        out.push(base);
        continue;
      }
      const wrapped = wrap(label.text, label.fontSize, (skeleton.width ?? 0) - PADDING * 2);
      const block = measure(wrapped, label.fontSize);
      // redrawTextBoundingBox GROWS a container whose label does not fit: that growth is what fitting detects.
      const width = Math.max(skeleton.width ?? 0, block.width + PADDING * 2);
      const height = Math.max(skeleton.height ?? 0, block.height + PADDING * 2);
      const container = { ...base, width, height };
      out.push(container, {
        id: nextId(),
        type: "text",
        text: wrapped,
        originalText: label.text,
        fontSize: label.fontSize,
        fontFamily: label.fontFamily,
        strokeColor: label.strokeColor ?? "#1e1e1e",
        opacity: label.opacity ?? 100,
        width: block.width,
        height: block.height,
        x: (skeleton.x ?? 0) + (width - block.width) / 2,
        y: (skeleton.y ?? 0) + (height - block.height) / 2,
        angle: 0,
        containerId: container.id,
        autoResize: true,
        lineHeight: LINE_HEIGHT,
        textAlign: label.textAlign ?? "center",
        verticalAlign: label.verticalAlign ?? "middle",
        isDeleted: false,
        version: 1,
      });
    }
    return out;
  },
}));

import { isFailedWarning, isInterimText, isRegionMarker, type StrokeShape, type StyleSnapshot } from "../../src/contracts";
import { fit } from "../../src/fit";
import type { ExcalidrawElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";

const SENTENCE = "The whiteboard session ran long so we wrote every decision down";

const style: StyleSnapshot = {
  strokeColor: "#1e1e1e",
  backgroundColor: "#ffc9c9",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  roundness: "round",
  fontFamily: 5 as StyleSnapshot["fontFamily"],
};

const OVAL: StrokeShape = { kind: "ellipse", x: 100, y: 200, width: 300, height: 160 };
const STRAIGHT: StrokeShape = { kind: "line", start: { x: 100, y: 500 }, end: { x: 500, y: 500 }, length: 400 };

type El = ExcalidrawElement & { text?: string; containerId?: string | null; autoResize?: boolean };
const asText = (el: ExcalidrawElement): ExcalidrawTextElement => el as unknown as ExcalidrawTextElement;
const textOf = (els: readonly ExcalidrawElement[]): El =>
  els.find((el) => el.type === "text") as unknown as El;

/** Every pixel of the fitted text lies inside the region the founder drew. */
const insideRegion = (el: El, region: { x: number; y: number; width: number; height: number }): boolean =>
  el.x >= region.x - 0.5 &&
  el.y >= region.y - 0.5 &&
  el.x + el.width <= region.x + region.width + 0.5 &&
  el.y + el.height <= region.y + region.height + 0.5;

beforeEach(() => {
  ids = 0;
});

describe("a stroke produces a region marker, not a drawing", () => {
  it("makes an ellipse stroke a dashed RECTANGLE on the stroke's bounding box, stamped as a region", () => {
    const { elements, target } = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = elements as El[];

    expect(marker!.type, "the region is the bounding box, so the marker is its rectangle").toBe("rectangle");
    expect({ x: marker!.x, y: marker!.y, width: marker!.width, height: marker!.height }).toEqual({
      x: 100,
      y: 200,
      width: 300,
      height: 160,
    });
    expect(isRegionMarker(marker!), "a marker is told from the founder's own shapes forever").toBe(true);
    expect(marker!.strokeStyle).toBe("dashed");
    expect(marker!.backgroundColor, "never filled").toBe("transparent");
    expect(marker!.strokeWidth, "thin: scaffolding, not ink").toBe(1);
    expect(marker!.opacity, "faint").toBe(60);
    expect(marker!.roundness, "the marker's box IS the region's box").toBeNull();
    expect(marker!.strokeColor, "but still the founder's colour").toBe(style.strokeColor);

    expect(target.markerId).toBe(marker!.id);
    expect(target.textId).toBe(placeholder!.id);
    expect(placeholder!.text, "the animated placeholder sits where the text will go").toBe("·");
    expect(insideRegion(placeholder!, OVAL)).toBe(true);
  });

  it("marks a line stroke's own dashed line as the region", () => {
    const { elements, target } = fit.buildPlaceholder(STRAIGHT, style);
    const [marker, placeholder] = elements as El[];
    expect(marker!.type).toBe("line");
    expect(isRegionMarker(marker!)).toBe(true);
    expect(marker!.strokeStyle).toBe("dashed");
    expect(target.markerId).toBe(marker!.id);
    expect(placeholder!.text).toBe("·");
  });

  it("turns a shape drawn with a native tool into a marker too, without moving it", () => {
    const drawn = {
      id: "drawn-1",
      type: "rectangle",
      x: 10,
      y: 20,
      width: 240,
      height: 120,
      angle: 0,
      strokeColor: "#1971c2",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      roundness: null,
      isDeleted: false,
      version: 3,
      boundElements: null,
    } as unknown as ExcalidrawElement;
    const { elements, target } = fit.buildPlaceholderFor(drawn, style);
    const marker = elements.find((el) => el.id === "drawn-1") as El;
    expect(isRegionMarker(marker)).toBe(true);
    expect(marker.strokeStyle).toBe("dashed");
    expect({ x: marker.x, y: marker.y }).toEqual({ x: 10, y: 20 });
    expect(target.markerId).toBe("drawn-1");
  });
});

describe("the commit leaves the text alone in the region", () => {
  it("frees the text, keeps it inside the region and deletes the marker in the same update", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    const committed = fit.commitText(built.target, asText(placeholder!), SENTENCE, style, marker);

    const text = textOf(committed);
    expect(text.id, "the placeholder's id survives placeholder → commit").toBe(placeholder!.id);
    expect(text.containerId, "a free text: the container it was measured in no longer exists").toBeNull();
    expect(text.autoResize, "false at the fitted width, so the wrapped lines stay where they were measured").toBe(
      false,
    );
    expect((text.text ?? "").replace(/\n/g, " ")).toBe(SENTENCE);
    expect(insideRegion(text, OVAL), `text ${text.x},${text.y} ${text.width}x${text.height}`).toBe(true);

    const gone = committed.find((el) => el.id === marker!.id);
    expect(gone, "the marker is in the same update, not a later one").toBeTruthy();
    expect(gone!.isDeleted, "nothing but the text remains").toBe(true);
    expect(committed).toHaveLength(2);
  });

  it("fits the LARGEST font size the region takes: one step up no longer fits", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    const fitted = textOf(fit.commitText(built.target, asText(placeholder!), SENTENCE, style, marker));
    const fontSize = (fitted as unknown as { fontSize: number }).fontSize;

    // Raising the ceiling to exactly one step above the chosen size must change nothing: if fontSize + 1 fitted,
    // the search would have taken it. (A ceiling of maxFontSize would prove nothing about the region.)
    const again = textOf(
      fit.commitText(built.target, asText(placeholder!), SENTENCE, style, null, { maxFontSize: fontSize + 1 }),
    );
    expect((again as unknown as { fontSize: number }).fontSize).toBe(fontSize);
    expect(fontSize).toBeGreaterThanOrEqual(10);
  });

  it("recommits a second utterance into the region with the marker already gone", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    const first = fit.commitText(built.target, asText(placeholder!), "회의 목표", style, marker);
    const committedText = asText(textOf(first) as unknown as ExcalidrawElement);

    // The marker is deleted by now, so the geometry can only come from the target: this is the round-4a contract.
    const second = fit.commitText(built.target, committedText, `회의 목표 ${SENTENCE}`, style, null);
    expect(second, "nothing to delete a second time").toHaveLength(1);
    const text = textOf(second);
    expect(text.id).toBe(placeholder!.id);
    expect(text.containerId).toBeNull();
    expect(insideRegion(text, OVAL)).toBe(true);
  });

  it("deletes the marker for a line region as well", () => {
    const built = fit.buildPlaceholder(STRAIGHT, style);
    const [marker, placeholder] = built.elements;
    const committed = fit.commitText(built.target, asText(placeholder!), "voice tool", style, marker);
    expect(committed.find((el) => el.id === marker!.id)!.isDeleted).toBe(true);
    expect(textOf(committed).containerId, "line text was never bound").toBeNull();
  });
});

/**
 * Round 5. A preview is the same FIT as a commit — otherwise the words jump when the final transcript lands — but
 * the take is not over: the marker stays, the text stays bound to it, it is faint, and it is stamped so that a
 * reload can sweep it. And the region it borrowed has to be restorable, because the provisional assignment can be
 * wrong.
 */
describe("an interim preview is a commit that has not happened yet", () => {
  it("fits like a commit but keeps the marker, dims the text and stamps it", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    const preview = fit.commitInterim(built.target, asText(placeholder!), SENTENCE, style, marker);

    expect(preview, "only the text is written: the region marker is untouched").toHaveLength(1);
    const text = textOf(preview);
    expect(text.id, "the same element the commit will overwrite").toBe(placeholder!.id);
    expect(text.customData?.voiceInterim, "stamped, so a reload sweeps it").toBe(true);
    expect((text as unknown as { opacity: number }).opacity, "faint: not settled yet").toBeLessThan(100);
    expect(insideRegion(text, OVAL), `preview ${text.x},${text.y} ${text.width}x${text.height}`).toBe(true);

    const committed = textOf(fit.commitText(built.target, asText(text as unknown as ExcalidrawElement), SENTENCE, style, marker));
    expect(committed.customData?.voiceInterim, "the commit clears the stamp").toBeUndefined();
    expect((committed as unknown as { fontSize: number }).fontSize, "and lands at the size the preview showed").toBe(
      (text as unknown as { fontSize: number }).fontSize,
    );
  });

  it("previews nothing for an empty answer instead of discarding the region", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    expect(fit.commitInterim(built.target, asText(placeholder!), "   ", style, marker)).toHaveLength(0);
  });

  it("puts the placeholder back when the final assignment picks another region", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    const preview = asText(textOf(fit.commitInterim(built.target, asText(placeholder!), SENTENCE, style, marker)) as unknown as ExcalidrawElement);

    const back = fit.resetPlaceholder(built.target, marker!, preview, style);
    expect(back).toHaveLength(1);
    const text = textOf(back);
    expect(text.text, "the region is waiting again").toBe("·");
    expect(text.customData?.voiceInterim, "with the stamp cleared").toBeUndefined();
    expect(text.containerId, "and bound to its marker exactly as the placeholder was").toBe(marker!.id);
    expect((text as unknown as { fontSize: number }).fontSize, "at the placeholder's own size").toBe(
      (asText(placeholder!) as unknown as { fontSize: number }).fontSize,
    );
  });

  it("previews and resets a LINE region, whose text is free rather than bound", () => {
    const built = fit.buildPlaceholder(STRAIGHT, style);
    const [marker, placeholder] = built.elements;
    const preview = textOf(fit.commitInterim(built.target, asText(placeholder!), "voice tool", style, marker));
    expect(preview.containerId, "line text was never bound").toBeNull();
    expect(preview.customData?.voiceInterim).toBe(true);
    const back = textOf(fit.resetPlaceholder(built.target, marker!, asText(preview as unknown as ExcalidrawElement), style));
    expect(back.text).toBe("·");
    expect(back.customData?.voiceInterim).toBeUndefined();
  });
});

describe("failure keeps the marker, a discard keeps nothing", () => {
  it("writes ⚠ STT in the region and leaves the marker dashed for the retry to aim at", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    const failed = fit.markFailed(built.target, marker!, asText(placeholder!), style);

    const kept = failed.find((el) => el.id === marker!.id) as El;
    expect(kept, "the region the retry will land in is still visible").toBeTruthy();
    expect(kept.isDeleted).toBe(false);
    expect(kept.strokeStyle).toBe("dashed");
    const text = textOf(failed);
    expect(text.text).toBe("⚠ STT");
    expect(text.strokeColor).toBe("#c92a2a");
    expect(insideRegion(text, OVAL)).toBe(true);
  });

  it("warns as a free text when the marker was already removed by an earlier commit", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [, placeholder] = built.elements;
    const failed = fit.markFailed(built.target, null, asText(placeholder!), style);
    expect(failed).toHaveLength(1);
    expect(textOf(failed).containerId).toBeNull();
    expect(textOf(failed).text).toBe("⚠ STT");
  });

  it("stamps the warning so a reload can sweep it, bound or not", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    const bound = textOf(fit.markFailed(built.target, marker!, asText(placeholder!), style));
    expect(isFailedWarning(bound), "litter is decided by the stamp, never by reading the text").toBe(true);

    const free = textOf(fit.markFailed(built.target, null, asText(placeholder!), style));
    expect(isFailedWarning(free), "an unbound warning is the case the sweep could not see at all").toBe(true);
  });

  it("clears the stamp again when a retry finally lands the words", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    const warned = asText(textOf(fit.markFailed(built.target, marker!, asText(placeholder!), style)) as unknown as ExcalidrawElement);
    const committed = textOf(fit.commitText(built.target, warned, SENTENCE, style, null));
    expect(isFailedWarning(committed), "otherwise the next reload would sweep the transcript away").toBe(false);
  });

  it("never writes over words that already landed", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    // First take commits (the marker goes), then a second utterance into the same region fails.
    const committed = asText(
      textOf(fit.commitText(built.target, asText(placeholder!), SENTENCE, style, marker)) as unknown as ExcalidrawElement,
    );
    const failed = fit.markFailed(built.target, null, committed, style);
    expect(failed, "the transcript is the only copy there is: nothing may overwrite it").toHaveLength(0);
  });

  it("DOES write over an interim preview: the preview is this take's own guess, not a copy of anything", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    // A preview landed ("Ship the"), then the FINAL transcript of the same utterance failed. Until round 5b the
    // words in the preview made hasLandedTranscript() true, markFailed returned [] and the failure was reported
    // nowhere — the region kept half a sentence at 45 % that persist.ts deleted on the next reload.
    const previewed = asText(
      textOf(fit.commitInterim(built.target, asText(placeholder!), "Ship the", style, marker)) as unknown as ExcalidrawElement,
    );
    const failed = fit.markFailed(built.target, marker!, previewed, style);
    const warning = textOf(failed);
    expect(warning.text, "the founder is told the take failed, in the region they spoke into").toBe("⚠ STT");
    expect(isFailedWarning(warning), "stamped, so a reload sweeps a warning and not a transcript").toBe(true);
    expect(isInterimText(warning), "and the preview's own stamp is gone").toBe(false);
  });

  it("deletes BOTH halves when no speech ever landed", () => {
    const built = fit.buildPlaceholder(OVAL, style);
    const [marker, placeholder] = built.elements;
    const discarded = fit.discard(built.target, marker!, asText(placeholder!), style);
    expect(discarded).toHaveLength(2);
    expect(discarded.every((el) => el.isDeleted), "the founder's canvas is as it was").toBe(true);
  });
});
