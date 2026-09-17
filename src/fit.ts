/**
 * fit.ts — builds the Excalidraw elements a voice segment needs, and fits transcripts into them.
 *
 * Every measurement is delegated to the library: `convertToExcalidrawElements` runs the same
 * `bindTextToContainer` → `redrawTextBoundingBox` path the editor itself uses, so a throwaway "probe" element
 * tells us exactly what the editor would do with a given font size — including growing the container when the
 * text does not fit. Fitting is therefore a binary search for the largest size that leaves the container alone.
 *
 * Probes always carry fresh ids: `redrawTextBoundingBox` writes the grown height into a module-level cache keyed
 * by container id, and polluting that cache for a real container would make the editor snap it back later.
 * What we hand back are `newElementWith` copies of the caller's own elements, so ids and seeds survive
 * placeholder → commit and the version counter is bumped exactly once per update.
 */
import { ROUNDNESS, convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type {
  BoundElement,
  ExcalidrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  FontFamilyValues,
  StrokeStyle,
} from "@excalidraw/excalidraw/element/types";
import type {
  FitModule,
  FitOptions,
  PlaceholderResult,
  Point,
  StrokeShape,
  StyleSnapshot,
  VoiceTarget,
} from "./contracts";

/** Container width/height may drift by this much and still count as "the text fits". */
const FIT_TOLERANCE = 0.5;
/** Gap between a line and the baseline box of the text sitting on it (scene px). */
const LINE_TEXT_GAP = 4;
const PLACEHOLDER_FRAMES = ["·", "··", "···"] as const;
const PLACEHOLDER_HEIGHT_RATIO = 0.35;
const PLACEHOLDER_MIN_FONT_SIZE = 12;
const LINE_PLACEHOLDER_FONT_SIZE = 24;
const FAILED_TEXT = "⚠ STT";
const FAILED_FONT_SIZE = 14;
const FAILED_COLOR = "#c92a2a";
/** Guard rails so a corrupt settings value can never produce a NaN-sized element. */
const FONT_SIZE_CEILING = 400;

type AreaType = "rectangle" | "ellipse" | "diamond";
type Geometry = { x: number; y: number; width: number; height: number; angle: number };
type ShapeProps = {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: StyleSnapshot["fillStyle"];
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roughness: number;
  opacity: number;
  roundness: { type: number } | null;
};
type LabelProps = {
  fontFamily: FontFamilyValues;
  strokeColor: string;
  opacity: number;
};
type BoundPair = { container: ExcalidrawElement; text: ExcalidrawTextElement };
type LineGeometry = { mid: Point; dx: number; dy: number; length: number };

const AREA_TYPES: readonly string[] = ["rectangle", "ellipse", "diamond"];

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** Any non-finite number coming from a corrupt element or settings blob collapses to a usable default. */
const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

// Generic in the element type so `Array.prototype.find` keeps narrowing over OrderedExcalidrawElement too.
const isTextElement = <T extends ExcalidrawElement>(el: T | null | undefined): el is T & ExcalidrawTextElement =>
  !!el && el.type === "text";

const isLinearElement = <T extends ExcalidrawElement>(el: T | null | undefined): el is T & ExcalidrawLinearElement =>
  !!el && (el.type === "line" || el.type === "arrow");

const isAreaType = (type: string): type is AreaType => AREA_TYPES.includes(type);

function resolveOptions(opts?: FitOptions) {
  const maxFontSize = clamp(Math.round(num(opts?.maxFontSize, 96)), 1, FONT_SIZE_CEILING);
  const minFontSize = clamp(Math.round(num(opts?.minFontSize, 10)), 1, maxFontSize);
  const lineMaxFontSize = clamp(Math.round(num(opts?.lineMaxFontSize, 36)), minFontSize, FONT_SIZE_CEILING);
  return { maxFontSize, minFontSize, lineMaxFontSize };
}

/** Matches `App.getCurrentItemRoundness`: rectangles use the adaptive radius, everything else proportional. */
function roundnessFor(type: string, roundness: StyleSnapshot["roundness"]): ShapeProps["roundness"] {
  if (roundness !== "round") {
    return null;
  }
  return { type: type === "rectangle" ? ROUNDNESS.ADAPTIVE_RADIUS : ROUNDNESS.PROPORTIONAL_RADIUS };
}

function propsFromStyle(style: StyleSnapshot, type: string, strokeStyle: StrokeStyle): ShapeProps {
  return {
    strokeColor: style.strokeColor,
    backgroundColor: style.backgroundColor,
    fillStyle: style.fillStyle,
    strokeWidth: num(style.strokeWidth, 1),
    strokeStyle,
    roughness: num(style.roughness, 1),
    opacity: clamp(num(style.opacity, 100), 0, 100),
    roundness: roundnessFor(type, style.roundness),
  };
}

/** A probe must look exactly like the real element, so its style is read off the element, not the snapshot. */
function propsFromElement(el: ExcalidrawElement, strokeStyle: StrokeStyle): ShapeProps {
  return {
    strokeColor: el.strokeColor,
    backgroundColor: el.backgroundColor,
    fillStyle: el.fillStyle,
    strokeWidth: num(el.strokeWidth, 1),
    strokeStyle,
    roughness: num(el.roughness, 1),
    opacity: clamp(num(el.opacity, 100), 0, 100),
    roundness: el.roundness ? { type: el.roundness.type } : null,
  };
}

function geometryOf(el: ExcalidrawElement): Geometry {
  return {
    x: num(el.x),
    y: num(el.y),
    width: Math.max(1, Math.abs(num(el.width, 1))),
    height: Math.max(1, Math.abs(num(el.height, 1))),
    angle: num(el.angle),
  };
}

function geometryOfShape(shape: StrokeShape): Geometry {
  if (shape.kind === "line") {
    const x = Math.min(num(shape.start?.x), num(shape.end?.x));
    const y = Math.min(num(shape.start?.y), num(shape.end?.y));
    return {
      x,
      y,
      width: Math.max(1, Math.abs(num(shape.end?.x) - num(shape.start?.x))),
      height: Math.max(1, Math.abs(num(shape.end?.y) - num(shape.start?.y))),
      angle: 0,
    };
  }
  return {
    x: num(shape.x),
    y: num(shape.y),
    width: Math.max(1, Math.abs(num(shape.width, 1))),
    height: Math.max(1, Math.abs(num(shape.height, 1))),
    angle: 0,
  };
}

function withTextBinding(bound: readonly BoundElement[] | null, textId: string): BoundElement[] {
  // A container may hold only one bound text; a stale one would render on top of ours.
  const kept = (bound ?? []).filter((entry) => entry && entry.type !== "text");
  return [...kept, { id: textId, type: "text" }];
}

function withoutTextBinding(bound: readonly BoundElement[] | null, textId: string): BoundElement[] {
  return (bound ?? []).filter((entry) => entry && entry.id !== textId);
}

/**
 * Builds a container + bound text through the library. Returns null when the library could not produce the pair
 * (only reachable when text measurement itself is unavailable, i.e. outside a browser).
 */
function probeBoundPair(
  type: AreaType,
  geom: Geometry,
  props: ShapeProps,
  label: LabelProps,
  text: string,
  fontSize: number,
): BoundPair | null {
  try {
    const skeleton = {
      type,
      x: geom.x,
      y: geom.y,
      width: geom.width,
      height: geom.height,
      angle: geom.angle,
      ...props,
      label: {
        text,
        fontSize,
        fontFamily: label.fontFamily,
        strokeColor: label.strokeColor,
        opacity: label.opacity,
        textAlign: "center",
        verticalAlign: "middle",
      },
    } as unknown as ExcalidrawElementSkeleton;
    const built = convertToExcalidrawElements([skeleton]);
    const textEl = built.find(isTextElement);
    const container = built.find((el) => el.id === textEl?.containerId);
    return textEl && container ? { container, text: textEl } : null;
  } catch (err) {
    console.warn("fit: could not lay out bound text", err);
    return null;
  }
}

const containerUnchanged = (built: ExcalidrawElement, geom: Geometry) =>
  Math.abs(built.width - geom.width) <= FIT_TOLERANCE && Math.abs(built.height - geom.height) <= FIT_TOLERANCE;

/**
 * Largest integer font size in [minFontSize, maxFontSize] whose wrapped text does not grow the container.
 * Monotone in the font size, so a binary search is exact; if nothing fits, the smallest size is used and the
 * caller inherits the container the library grew.
 */
function fitBoundText(
  type: AreaType,
  geom: Geometry,
  props: ShapeProps,
  label: LabelProps,
  text: string,
  minFontSize: number,
  maxFontSize: number,
): BoundPair | null {
  let lo = minFontSize;
  let hi = Math.max(minFontSize, maxFontSize);
  let best: BoundPair | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pair = probeBoundPair(type, geom, props, label, text, mid);
    if (pair && containerUnchanged(pair.container, geom)) {
      best = pair;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best ?? probeBoundPair(type, geom, props, label, text, minFontSize);
}

function rotate(p: Point, cx: number, cy: number, angle: number): Point {
  if (!angle) {
    return p;
  }
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - cx;
  const dy = p.y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

function endpointsToGeometry(start: Point, end: Point): LineGeometry {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return {
    mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    dx,
    dy,
    length: Math.hypot(dx, dy),
  };
}

/** Scene-space endpoints of a line element (its own rotation included), falling back to the recognised stroke. */
function lineGeometry(el: ExcalidrawElement | null | undefined, shape?: StrokeShape): LineGeometry {
  if (isLinearElement(el) && Array.isArray(el.points) && el.points.length >= 2) {
    const pts = el.points.map((p) => ({ x: num(p?.[0]), y: num(p?.[1]) }));
    const first = pts[0];
    const last = pts[pts.length - 1];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    // Excalidraw rotates around the bounding-box centre, and x/y is the FIRST point, not the box corner.
    const cx = num(el.x) + (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = num(el.y) + (Math.min(...ys) + Math.max(...ys)) / 2;
    const angle = num(el.angle);
    const start = rotate({ x: num(el.x) + first.x, y: num(el.y) + first.y }, cx, cy, angle);
    const end = rotate({ x: num(el.x) + last.x, y: num(el.y) + last.y }, cx, cy, angle);
    return endpointsToGeometry(start, end);
  }
  if (shape && shape.kind === "line") {
    return endpointsToGeometry(
      { x: num(shape.start?.x), y: num(shape.start?.y) },
      { x: num(shape.end?.x), y: num(shape.end?.y) },
    );
  }
  if (el) {
    const g = geometryOf(el);
    return endpointsToGeometry({ x: g.x, y: g.y + g.height / 2 }, { x: g.x + g.width, y: g.y + g.height / 2 });
  }
  return { mid: { x: 0, y: 0 }, dx: 1, dy: 0, length: 1 };
}

/** Rotation that keeps text readable: the line's slope folded into (-π/2, π/2]. */
function readableAngle(dx: number, dy: number): number {
  if (!dx && !dy) {
    return 0;
  }
  let angle = Math.atan2(dy, dx);
  while (angle > Math.PI / 2) {
    angle -= Math.PI;
  }
  while (angle <= -Math.PI / 2) {
    angle += Math.PI;
  }
  return angle;
}

/** Unit normal pointing at the line's upper side (smaller y in scene space). */
function upperNormal(g: LineGeometry): Point {
  if (!g.length) {
    return { x: 0, y: -1 };
  }
  const nx = -g.dy / g.length;
  const ny = g.dx / g.length;
  // Perfectly horizontal lines get ny === 0 from one normal and 0 from the other; pick "up" explicitly.
  return ny <= 0 ? { x: nx, y: ny === 0 ? -1 : ny } : { x: -nx, y: -ny };
}

/** Single-line metrics through the library's own text measurement. */
function measureOnly(text: string, fontSize: number, fontFamily: number): { width: number; height: number } {
  const size = clamp(Math.round(num(fontSize, 20)), 1, FONT_SIZE_CEILING);
  const single = String(text ?? "").replace(/\s+/g, " ");
  try {
    const built = convertToExcalidrawElements([
      {
        type: "text",
        x: 0,
        y: 0,
        text: single,
        fontSize: size,
        fontFamily: fontFamily as FontFamilyValues,
      },
    ]);
    const textEl = built.find(isTextElement);
    if (textEl) {
      return { width: textEl.width, height: textEl.height };
    }
  } catch (err) {
    console.warn("fit: text measurement failed", err);
  }
  // Crude but finite: roughly the advance width of a proportional font, so callers still get usable geometry.
  return { width: single.length * size * 0.6, height: size * 1.25 };
}

type LineTextLayout = {
  text: string;
  fontSize: number;
  width: number;
  height: number;
  x: number;
  y: number;
  angle: number;
  autoResize: boolean;
};

/**
 * Places one line of text along a line element: centred on the midpoint, nudged to the upper side, rotated with
 * the slope. When even `minFontSize` is wider than the line, the size is kept and the element is pinned to the
 * line's length (`autoResize: false`) so the overflow spills symmetrically instead of running off one end.
 */
function layoutLineText(
  g: LineGeometry,
  content: string,
  fontFamily: FontFamilyValues,
  minFontSize: number,
  maxFontSize: number,
): LineTextLayout {
  const single = content.replace(/\s+/g, " ").trim() || content;
  let lo = minFontSize;
  let hi = Math.max(minFontSize, maxFontSize);
  let chosen = minFontSize;
  let metrics = measureOnly(single, minFontSize, fontFamily);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = measureOnly(single, mid, fontFamily);
    if (m.width <= g.length) {
      chosen = mid;
      metrics = m;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const overflows = metrics.width > g.length;
  const width = overflows ? Math.max(1, g.length) : metrics.width;
  const normal = upperNormal(g);
  const offset = metrics.height / 2 + LINE_TEXT_GAP;
  const cx = g.mid.x + normal.x * offset;
  const cy = g.mid.y + normal.y * offset;
  return {
    text: single,
    fontSize: chosen,
    width,
    height: metrics.height,
    // x/y are the top-left BEFORE rotation; Excalidraw spins the element around its own centre.
    x: cx - width / 2,
    y: cy - metrics.height / 2,
    angle: readableAngle(g.dx, g.dy),
    autoResize: !overflows,
  };
}

/** A fresh, unbound text element carrying the given layout. */
function newLineText(
  layout: LineTextLayout,
  fontFamily: FontFamilyValues,
  strokeColor: string,
  opacity: number,
): ExcalidrawTextElement | null {
  try {
    const built = convertToExcalidrawElements([
      {
        type: "text",
        x: layout.x,
        y: layout.y,
        text: layout.text,
        fontSize: layout.fontSize,
        fontFamily,
        strokeColor,
        opacity,
        textAlign: "center",
        verticalAlign: "middle",
      },
    ]);
    const textEl = built.find(isTextElement);
    return textEl ? applyLineLayout(textEl, layout) : null;
  } catch (err) {
    console.warn("fit: could not build line text", err);
    return null;
  }
}

function applyLineLayout(text: ExcalidrawTextElement, layout: LineTextLayout): ExcalidrawTextElement {
  return newElementWith(text, {
    text: layout.text,
    originalText: layout.text,
    fontSize: layout.fontSize,
    width: layout.width,
    height: layout.height,
    x: layout.x,
    y: layout.y,
    angle: layout.angle as ExcalidrawTextElement["angle"],
    autoResize: layout.autoResize,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: null,
    isDeleted: false,
  });
}

/** Copies a probed bound-text layout onto the caller's own text element, keeping its id. */
function applyBoundLayout(
  text: ExcalidrawTextElement,
  probed: ExcalidrawTextElement,
  containerId: string,
  originalText: string,
): ExcalidrawTextElement {
  return newElementWith(text, {
    text: probed.text,
    originalText,
    fontSize: probed.fontSize,
    fontFamily: probed.fontFamily,
    lineHeight: probed.lineHeight,
    width: probed.width,
    height: probed.height,
    x: probed.x,
    y: probed.y,
    angle: probed.angle,
    strokeColor: probed.strokeColor,
    opacity: probed.opacity,
    textAlign: "center",
    verticalAlign: "middle",
    autoResize: probed.autoResize,
    containerId,
    isDeleted: false,
  });
}

/** Placeholder dot size: a comfortable fraction of the shape, never below 12px nor above the user's ceiling. */
function placeholderFontSize(geom: Geometry, maxFontSize: number): number {
  const wanted = Math.round(Math.min(geom.width, geom.height) * PLACEHOLDER_HEIGHT_RATIO);
  return clamp(wanted, PLACEHOLDER_MIN_FONT_SIZE, maxFontSize);
}

function buildAreaPlaceholder(
  type: AreaType,
  geom: Geometry,
  props: ShapeProps,
  label: LabelProps,
  shape: StrokeShape,
  minFontSize: number,
  maxFontSize: number,
): PlaceholderResult {
  const wanted = placeholderFontSize(geom, maxFontSize);
  // Search down from the wanted size so a shallow box gets a smaller dot rather than being grown.
  const pair =
    fitBoundText(type, geom, props, label, PLACEHOLDER_FRAMES[0], minFontSize, Math.max(minFontSize, wanted)) ??
    probeBoundPair(type, geom, props, label, PLACEHOLDER_FRAMES[0], minFontSize);
  if (!pair) {
    return { elements: [], target: { containerId: "", textId: "", shape } };
  }
  return {
    elements: [pair.container, pair.text],
    target: { containerId: pair.container.id, textId: pair.text.id, shape },
  };
}

function buildLinePlaceholder(
  lineEl: ExcalidrawElement,
  shape: StrokeShape,
  fontFamily: FontFamilyValues,
  strokeColor: string,
  opacity: number,
  minFontSize: number,
  lineMaxFontSize: number,
): PlaceholderResult {
  const g = lineGeometry(lineEl, shape);
  const fontSize = clamp(Math.min(lineMaxFontSize, LINE_PLACEHOLDER_FONT_SIZE), minFontSize, FONT_SIZE_CEILING);
  const layout = layoutLineText(g, PLACEHOLDER_FRAMES[0], fontFamily, fontSize, fontSize);
  const textEl = newLineText(layout, fontFamily, strokeColor, opacity);
  if (!textEl) {
    return { elements: [lineEl], target: { containerId: lineEl.id, textId: "", shape } };
  }
  return {
    elements: [lineEl, textEl],
    target: { containerId: lineEl.id, textId: textEl.id, shape },
  };
}

function newLineElement(shape: StrokeShape, props: ShapeProps): ExcalidrawElement | null {
  const g = shape.kind === "line" ? shape : null;
  const start = { x: num(g?.start?.x), y: num(g?.start?.y) };
  const end = { x: num(g?.end?.x, start.x + 1), y: num(g?.end?.y, start.y) };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  try {
    const built = convertToExcalidrawElements([
      {
        type: "line",
        x: start.x,
        y: start.y,
        width: Math.abs(dx),
        height: Math.abs(dy),
        points: [
          [0, 0],
          [dx, dy],
        ],
        ...props,
      } as unknown as ExcalidrawElementSkeleton,
    ]);
    return built.find(isLinearElement) ?? null;
  } catch (err) {
    console.warn("fit: could not build line", err);
    return null;
  }
}

/** Derives the StrokeShape a caller-supplied element stands for. Diamonds and anything odd read as a rectangle. */
function shapeOfElement(el: ExcalidrawElement): StrokeShape {
  if (isLinearElement(el)) {
    const g = lineGeometry(el);
    return {
      kind: "line",
      start: { x: g.mid.x - g.dx / 2, y: g.mid.y - g.dy / 2 },
      end: { x: g.mid.x + g.dx / 2, y: g.mid.y + g.dy / 2 },
      length: g.length,
    };
  }
  const geom = geometryOf(el);
  return {
    kind: el.type === "ellipse" ? "ellipse" : "rectangle",
    x: geom.x,
    y: geom.y,
    width: geom.width,
    height: geom.height,
  };
}

function buildPlaceholder(shape: StrokeShape, style: StyleSnapshot, opts?: FitOptions): PlaceholderResult {
  const { maxFontSize, minFontSize, lineMaxFontSize } = resolveOptions(opts);
  if (shape?.kind === "line") {
    const lineEl = newLineElement(shape, propsFromStyle(style, "line", "dashed"));
    if (!lineEl) {
      return { elements: [], target: { containerId: "", textId: "", shape } };
    }
    return buildLinePlaceholder(
      lineEl,
      shape,
      style.fontFamily,
      style.strokeColor,
      clamp(num(style.opacity, 100), 0, 100),
      minFontSize,
      lineMaxFontSize,
    );
  }
  const type: AreaType = shape?.kind === "ellipse" ? "ellipse" : "rectangle";
  const geom = geometryOfShape(shape);
  return buildAreaPlaceholder(
    type,
    geom,
    propsFromStyle(style, type, "dashed"),
    { fontFamily: style.fontFamily, strokeColor: style.strokeColor, opacity: clamp(num(style.opacity, 100), 0, 100) },
    shape,
    minFontSize,
    maxFontSize,
  );
}

function buildPlaceholderFor(
  container: ExcalidrawElement,
  style: StyleSnapshot,
  opts?: FitOptions,
): PlaceholderResult {
  const { maxFontSize, minFontSize, lineMaxFontSize } = resolveOptions(opts);
  const shape = shapeOfElement(container);
  const dashed = newElementWith(container, { strokeStyle: "dashed" as StrokeStyle });

  if (isLinearElement(container)) {
    // Text along a line is never bound to it — a bound label on a linear element is laid out as an arrow label.
    return buildLinePlaceholder(
      dashed,
      shape,
      style.fontFamily,
      container.strokeColor,
      clamp(num(container.opacity, 100), 0, 100),
      minFontSize,
      lineMaxFontSize,
    );
  }

  const type: AreaType = isAreaType(container.type) ? container.type : "rectangle";
  const geom = geometryOf(container);
  const label: LabelProps = {
    fontFamily: style.fontFamily,
    strokeColor: container.strokeColor,
    opacity: clamp(num(container.opacity, 100), 0, 100),
  };
  const wanted = placeholderFontSize(geom, maxFontSize);
  const pair = fitBoundText(
    type,
    geom,
    propsFromElement(container, "dashed"),
    label,
    PLACEHOLDER_FRAMES[0],
    minFontSize,
    Math.max(minFontSize, wanted),
  );
  if (!pair) {
    return { elements: [dashed], target: { containerId: container.id, textId: "", shape } };
  }
  const text = newElementWith(pair.text, { containerId: container.id });
  const updated = newElementWith(container, {
    strokeStyle: "dashed" as StrokeStyle,
    width: pair.container.width,
    height: pair.container.height,
    boundElements: withTextBinding(container.boundElements, text.id),
  });
  return { elements: [updated, text], target: { containerId: container.id, textId: text.id, shape } };
}

function setPlaceholderFrame(text: ExcalidrawTextElement, frame: number): ExcalidrawTextElement {
  const index = ((Math.trunc(num(frame)) % PLACEHOLDER_FRAMES.length) + PLACEHOLDER_FRAMES.length) %
    PLACEHOLDER_FRAMES.length;
  const content = PLACEHOLDER_FRAMES[index];
  const metrics = measureOnly(content, text.fontSize, text.fontFamily);
  // The dots grow rightwards; nudge x so a centred placeholder keeps its centre instead of drifting.
  const dx = text.textAlign === "center" ? (text.width - metrics.width) / 2 : 0;
  return newElementWith(text, {
    text: content,
    originalText: content,
    width: metrics.width,
    height: metrics.height,
    x: text.x + dx,
  });
}

function commitToContainer(
  target: VoiceTarget,
  container: ExcalidrawElement,
  text: ExcalidrawTextElement,
  content: string,
  strokeStyle: StrokeStyle,
  fontFamily: FontFamilyValues,
  minFontSize: number,
  maxFontSize: number,
): ExcalidrawElement[] {
  const type: AreaType = isAreaType(container.type) ? container.type : "rectangle";
  const geom = geometryOf(container);
  const label: LabelProps = {
    fontFamily,
    strokeColor: container.strokeColor,
    opacity: clamp(num(container.opacity, 100), 0, 100),
  };
  const pair = fitBoundText(type, geom, propsFromElement(container, strokeStyle), label, content, minFontSize, maxFontSize);
  const restored = newElementWith(container, {
    strokeStyle,
    width: pair ? pair.container.width : container.width,
    height: pair ? pair.container.height : container.height,
    boundElements: withTextBinding(container.boundElements, target.textId || text.id),
  });
  if (!pair) {
    return [restored, newElementWith(text, { text: content, originalText: content, isDeleted: false })];
  }
  return [restored, applyBoundLayout(text, pair.text, container.id, content)];
}

function commitToLine(
  container: ExcalidrawElement,
  text: ExcalidrawTextElement,
  content: string,
  shape: StrokeShape,
  strokeStyle: StrokeStyle,
  fontFamily: FontFamilyValues,
  minFontSize: number,
  lineMaxFontSize: number,
): ExcalidrawElement[] {
  const g = lineGeometry(container, shape);
  const layout = layoutLineText(g, content, fontFamily, minFontSize, Math.max(minFontSize, lineMaxFontSize));
  return [
    newElementWith(container, { strokeStyle }),
    newElementWith(applyLineLayout(text, layout), { strokeColor: container.strokeColor }),
  ];
}

function commitText(
  target: VoiceTarget,
  container: ExcalidrawElement,
  text: ExcalidrawTextElement,
  transcript: string,
  style: StyleSnapshot,
  opts?: FitOptions,
): ExcalidrawElement[] {
  const { maxFontSize, minFontSize, lineMaxFontSize } = resolveOptions(opts);
  const content = String(transcript ?? "").trim();
  if (!content) {
    // The controller is meant to call discard() for this; doing it here keeps an empty result harmless.
    return discard(target, container, text, style);
  }
  if (isLinearElement(container)) {
    return commitToLine(
      container,
      text,
      content,
      target?.shape ?? shapeOfElement(container),
      style.strokeStyle,
      style.fontFamily,
      minFontSize,
      lineMaxFontSize,
    );
  }
  return commitToContainer(
    target,
    container,
    text,
    content,
    style.strokeStyle,
    style.fontFamily,
    minFontSize,
    maxFontSize,
  );
}

function markFailed(
  target: VoiceTarget,
  container: ExcalidrawElement,
  text: ExcalidrawTextElement,
  style: StyleSnapshot,
): ExcalidrawElement[] {
  if (isLinearElement(container)) {
    const g = lineGeometry(container, target?.shape);
    const layout = layoutLineText(g, FAILED_TEXT, style.fontFamily, FAILED_FONT_SIZE, FAILED_FONT_SIZE);
    return [
      newElementWith(container, { strokeStyle: style.strokeStyle }),
      newElementWith(applyLineLayout(text, layout), { strokeColor: FAILED_COLOR }),
    ];
  }
  const type: AreaType = isAreaType(container.type) ? container.type : "rectangle";
  const geom = geometryOf(container);
  const pair = probeBoundPair(
    type,
    geom,
    propsFromElement(container, style.strokeStyle),
    { fontFamily: style.fontFamily, strokeColor: FAILED_COLOR, opacity: clamp(num(container.opacity, 100), 0, 100) },
    FAILED_TEXT,
    FAILED_FONT_SIZE,
  );
  const restored = newElementWith(container, {
    strokeStyle: style.strokeStyle,
    width: pair ? pair.container.width : container.width,
    height: pair ? pair.container.height : container.height,
    boundElements: withTextBinding(container.boundElements, target?.textId || text.id),
  });
  if (!pair) {
    return [restored, newElementWith(text, { text: FAILED_TEXT, originalText: FAILED_TEXT, strokeColor: FAILED_COLOR })];
  }
  return [restored, applyBoundLayout(text, pair.text, container.id, FAILED_TEXT)];
}

function discard(
  target: VoiceTarget,
  container: ExcalidrawElement,
  text: ExcalidrawTextElement,
  style: StyleSnapshot,
): ExcalidrawElement[] {
  const textId = target?.textId || text.id;
  return [
    newElementWith(container, {
      strokeStyle: style.strokeStyle,
      boundElements: withoutTextBinding(container.boundElements, textId),
    }),
    newElementWith(text, { isDeleted: true }),
  ];
}

function buildFreeText(
  at: Point,
  transcript: string,
  style: StyleSnapshot,
  fontSize: number,
): ExcalidrawTextElement {
  const size = clamp(Math.round(num(fontSize, 20)), 1, FONT_SIZE_CEILING);
  const content = String(transcript ?? "");
  const built = convertToExcalidrawElements([
    {
      type: "text",
      x: num(at?.x),
      y: num(at?.y),
      text: content,
      fontSize: size,
      fontFamily: style.fontFamily,
      strokeColor: style.strokeColor,
      opacity: clamp(num(style.opacity, 100), 0, 100),
    },
  ]);
  const textEl = built.find(isTextElement);
  if (!textEl) {
    // convertToExcalidrawElements always yields the text element; this only guards a future library change.
    console.warn("fit: buildFreeText produced no text element");
  }
  return textEl as ExcalidrawTextElement;
}

export const fit: FitModule & { measureOnly: typeof measureOnly } = {
  buildPlaceholder,
  buildPlaceholderFor,
  setPlaceholderFrame,
  commitText,
  markFailed,
  discard,
  buildFreeText,
  measureOnly,
};

export { measureOnly };
export default fit;
