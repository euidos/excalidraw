/**
 * stroke.ts — pure stroke geometry. No DOM, no library imports beyond contract types.
 * Turns a raw stylus path into the shape the voice tool should draw in its place.
 */
import type { Point, RecognizeOptions, RecognizeStroke, StrokeShape } from "./contracts";

const DEFAULTS = {
  minSize: 12,
  lineDeviation: 0.12,
  rectFill: 0.87,
  maxLineAngleDeg: 60,
  verticalLineAreaWidth: 80,
} as const;

/** Back-and-forth scribbles keep a short chord relative to the travelled path; below this they are never a line. */
const MIN_CHORD_PATH_RATIO = 0.7;

/** Pointer streams repeat the same coordinate while the pen rests; duplicates skew path length and the shoelace sum. */
function dedupe(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && prev.x === p.x && prev.y === p.y) continue;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

function bbox(points: readonly Point[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

/** Largest distance of any point from the infinite line through a→b (from a itself when a and b coincide). */
function maxDeviation(points: readonly Point[], a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  let max = 0;
  for (const p of points) {
    const d =
      chord === 0
        ? Math.hypot(p.x - a.x, p.y - a.y)
        : Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / chord;
    if (d > max) max = d;
  }
  return max;
}

/** Shoelace over the implicitly closed polygon; absolute value, so winding direction does not matter. */
function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function areaShape(box: { x: number; y: number; width: number; height: number }, fill: number, rectFill: number): StrokeShape {
  return {
    kind: fill >= rectFill ? "rectangle" : "ellipse",
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  };
}

export const recognizeStroke: RecognizeStroke = (points, opts?: RecognizeOptions): StrokeShape | null => {
  const minSize = opts?.minSize ?? DEFAULTS.minSize;
  const lineDeviation = opts?.lineDeviation ?? DEFAULTS.lineDeviation;
  const rectFill = opts?.rectFill ?? DEFAULTS.rectFill;
  const maxLineAngleDeg = opts?.maxLineAngleDeg ?? DEFAULTS.maxLineAngleDeg;
  const verticalLineAreaWidth = opts?.verticalLineAreaWidth ?? DEFAULTS.verticalLineAreaWidth;

  const pts = dedupe(points);
  if (pts.length < 2) return null;

  const box = bbox(pts);
  if (Math.hypot(box.width, box.height) < minSize) return null;

  const start = pts[0]!;
  const end = pts[pts.length - 1]!;
  const chordLength = Math.hypot(end.x - start.x, end.y - start.y);
  const path = pathLength(pts);

  const straight =
    chordLength > 0 &&
    maxDeviation(pts, start, end) / chordLength <= lineDeviation &&
    chordLength >= MIN_CHORD_PATH_RATIO * path;

  if (straight) {
    const angleDeg = Math.abs(Math.atan2(end.y - start.y, end.x - start.x) * (180 / Math.PI));
    const fromHorizontal = angleDeg > 90 ? 180 - angleDeg : angleDeg;
    if (fromHorizontal > maxLineAngleDeg) {
      // A near-vertical stroke is unusable as a text line, so it becomes a container wide enough to hold words.
      // Its polygon area is ~0, so the fill rule would always say "ellipse"; a rectangle is the better container.
      const width = Math.max(box.width, verticalLineAreaWidth);
      const centerX = box.x + box.width / 2;
      return { kind: "rectangle", x: centerX - width / 2, y: box.y, width, height: box.height };
    }
    // Normalised left-to-right so downstream text never has to be drawn upside down.
    const [a, b] = start.x <= end.x ? [start, end] : [end, start];
    return { kind: "line", start: a, end: b, length: chordLength };
  }

  const boxArea = box.width * box.height;
  const fill = boxArea > 0 ? polygonArea(pts) / boxArea : 1;
  return areaShape(box, fill, rectFill);
};

export default recognizeStroke;
