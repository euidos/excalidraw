import { describe, expect, it } from "vitest";
import type { Point } from "../contracts";
import recognizeStrokeDefault, { recognizeStroke } from "../stroke";

/** Points on a circle, in drawing order, starting at angle 0. */
function circle(cx: number, cy: number, r: number, n: number): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
  });
}

/** Perimeter of a w×h rect at (x,y) with rounded corners, sampled counter-clockwise-free (drawing order). */
function roundedBox(x: number, y: number, w: number, h: number, radius = 10): Point[] {
  const corners: Array<[number, number, number]> = [
    // [cx, cy, start angle] of each quarter arc, in clockwise drawing order from the top-left
    [x + radius, y + radius, Math.PI],
    [x + w - radius, y + radius, -Math.PI / 2],
    [x + w - radius, y + h - radius, 0],
    [x + radius, y + h - radius, Math.PI / 2],
  ];
  const pts: Point[] = [];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
    }
  }
  pts.push({ ...pts[0]! });
  return pts;
}

/** Deterministic ±amp jitter so tests never flake. */
function jitter(i: number, amp: number): number {
  return Math.sin(i * 12.9898) * amp;
}

describe("recognizeStroke", () => {
  it("is exported as both a named and a default export", () => {
    expect(recognizeStrokeDefault).toBe(recognizeStroke);
  });

  it("recognises a synthetic circle as an ellipse with a square bbox", () => {
    const shape = recognizeStroke(circle(100, 100, 80, 64));
    expect(shape?.kind).toBe("ellipse");
    if (shape?.kind !== "ellipse") throw new Error("not an area");
    expect(shape.width).toBeGreaterThan(155);
    expect(shape.width).toBeLessThanOrEqual(160);
    expect(shape.height).toBeCloseTo(shape.width, 6);
  });

  it("recognises a rounded-corner box path as a rectangle", () => {
    const shape = recognizeStroke(roundedBox(20, 30, 200, 120));
    expect(shape?.kind).toBe("rectangle");
    if (shape?.kind !== "rectangle") throw new Error("not an area");
    expect(shape.x).toBeCloseTo(20, 6);
    expect(shape.y).toBeCloseTo(30, 6);
    expect(shape.width).toBeCloseTo(200, 6);
    expect(shape.height).toBeCloseTo(120, 6);
  });

  it("recognises a jittery straight diagonal as a line", () => {
    const pts: Point[] = Array.from({ length: 40 }, (_, i) => ({
      x: i * 10 + jitter(i, 2),
      y: 50 + i * 4 + jitter(i + 7, 2),
    }));
    const shape = recognizeStroke(pts);
    expect(shape?.kind).toBe("line");
    if (shape?.kind !== "line") throw new Error("not a line");
    expect(shape.start.x).toBeLessThanOrEqual(shape.end.x);
    expect(shape.length).toBeCloseTo(Math.hypot(shape.end.x - shape.start.x, shape.end.y - shape.start.y), 6);
  });

  it("normalises a right-to-left line so start.x <= end.x", () => {
    const rightToLeft: Point[] = Array.from({ length: 20 }, (_, i) => ({ x: 300 - i * 15, y: 100 + i }));
    const shape = recognizeStroke(rightToLeft);
    expect(shape?.kind).toBe("line");
    if (shape?.kind !== "line") throw new Error("not a line");
    expect(shape.start.x).toBeLessThanOrEqual(shape.end.x);
    expect(shape.start.x).toBeCloseTo(15, 6);
    expect(shape.end.x).toBeCloseTo(300, 6);
    expect(shape.length).toBeCloseTo(Math.hypot(285, 19), 6);
  });

  it("returns null for a tap", () => {
    expect(recognizeStroke([{ x: 10, y: 10 }, { x: 12, y: 11 }, { x: 13, y: 13 }])).toBeNull();
  });

  it("returns null for a single point and for repeated identical points", () => {
    expect(recognizeStroke([{ x: 5, y: 5 }])).toBeNull();
    expect(recognizeStroke([])).toBeNull();
    expect(recognizeStroke([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }])).toBeNull();
  });

  it("turns a near-vertical straight stroke into a widened area", () => {
    const pts: Point[] = Array.from({ length: 30 }, (_, i) => ({
      x: 100 + jitter(i, 3),
      y: i * (200 / 29),
    }));
    const shape = recognizeStroke(pts);
    expect(shape?.kind === "rectangle" || shape?.kind === "ellipse").toBe(true);
    if (shape?.kind === "line" || !shape) throw new Error("not an area");
    expect(shape.width).toBeGreaterThanOrEqual(80);
    expect(shape.height).toBeCloseTo(200, 0);
    // Centred on the stroke's x.
    expect(shape.x + shape.width / 2).toBeCloseTo(100, 0);
  });

  it("respects verticalLineAreaWidth", () => {
    const pts: Point[] = [{ x: 50, y: 0 }, { x: 51, y: 100 }, { x: 50, y: 200 }];
    const shape = recognizeStroke(pts, { verticalLineAreaWidth: 140 });
    if (!shape || shape.kind === "line") throw new Error("not an area");
    expect(shape.width).toBe(140);
  });

  it("does not call a wide flat zigzag a line", () => {
    const pts: Point[] = [
      { x: 0, y: 100 },
      { x: 120, y: 104 },
      { x: 20, y: 96 },
      { x: 140, y: 102 },
      { x: 30, y: 98 },
      { x: 150, y: 100 },
    ];
    const shape = recognizeStroke(pts);
    expect(shape?.kind).not.toBe("line");
  });

  it("honours minSize so a small stroke can still be recognised", () => {
    const small: Point[] = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 8, y: 0 }];
    expect(recognizeStroke(small)).toBeNull();
    expect(recognizeStroke(small, { minSize: 4 })?.kind).toBe("line");
  });
});
