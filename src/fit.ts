/**
 * fit.ts — builds the Excalidraw elements a voice segment needs, and fits transcripts into them.
 *
 * A drawn shape SELECTS A REGION; it is not a drawing (round 4a). So what a stroke produces is a dashed region
 * MARKER plus the text that will replace it, and a commit deletes the marker: the founder is left with the words
 * alone, fitted to the bounding box they drew around them.
 *
 * Every measurement is delegated to the library: `convertToExcalidrawElements` runs the same
 * `bindTextToContainer` → `redrawTextBoundingBox` path the editor itself uses, so a throwaway "probe" element
 * tells us exactly what the editor would do with a given font size — including growing a container the text does
 * not fit in, and wrapping a label to the container's width. Fitting an area is a binary search for the largest
 * size that leaves the probe container alone; the committed text then takes that probe's own layout and drops the
 * binding (containerId null, autoResize false at the measured width), so the lines stay exactly where they were
 * measured even though the container they were measured in is gone. Fitting a line is the largest size that still
 * fits on one line, and below that floor a block wrapped to the line's own length (R5).
 *
 * That measurement only throws where a document's font metrics are missing — outside a browser, which this module
 * is not contracted to run in. So there is no second, always-wrong measurement path here: every entry point runs
 * inside `guarded`, which warns once and hands the caller its own elements back unchanged.
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
import {
  VOICE_FAILED_CUSTOM_DATA,
  VOICE_INTERIM_CUSTOM_DATA,
  VOICE_REGION_CUSTOM_DATA,
  isInterimText,
} from "./contracts";
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
/** Gap between a line and the box of the text sitting on it (scene px). */
const LINE_TEXT_GAP = 4;
/** The library's own BOUND_TEXT_PADDING: a container wraps its label at (container width − 2 × this). */
const BOUND_TEXT_PADDING = 5;
const PLACEHOLDER_FRAMES = ["·", "··", "···"] as const;
const PLACEHOLDER_HEIGHT_RATIO = 0.35;
const PLACEHOLDER_MIN_FONT_SIZE = 12;
const LINE_PLACEHOLDER_FONT_SIZE = 24;
const FAILED_TEXT = "⚠ STT";
/** A marker is scaffolding, so it is drawn thin and faint: it must never read as the founder's own ink. */
const MARKER_OPACITY = 60;
const MARKER_STROKE_WIDTH = 1;
const FAILED_FONT_SIZE = 14;
const FAILED_COLOR = "#c92a2a";
/**
 * How solid an INTERIM transcript is drawn. It has to read as "not settled yet" from across the room while still
 * being legible, and it must never be mistaken for the committed words next to it (round 5).
 */
const INTERIM_OPACITY = 45;
/** Guard rails so a corrupt settings value can never produce a NaN-sized element. */
const FONT_SIZE_CEILING = 400;

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
/** Everything a piece of text needs that is not its content, size or position. */
type LabelProps = { fontFamily: FontFamilyValues; strokeColor: string; opacity: number };
type BoundPair = { container: ExcalidrawElement; text: ExcalidrawTextElement };
/**
 * The stand-in shape a measurement is made in: everything about it except the text and its size. Always a
 * RECTANGLE — the region a take is fitted into is the bounding box the founder drew, and the marker is gone by the
 * time the words land, so there is no ellipse or diamond to be faithful to (round 4c: one probe shape for the
 * placeholder and for the commit).
 */
type Probe = { type: "rectangle"; geom: Geometry; props: ShapeProps; label: LabelProps };
type LineGeometry = { mid: Point; dx: number; dy: number; length: number };
/** x/y are the top-left BEFORE rotation; Excalidraw spins a text element around its own centre. */
type LineTextLayout = {
  text: string;
  originalText: string;
  fontSize: number;
  width: number;
  height: number;
  x: number;
  y: number;
  angle: number;
  autoResize: boolean;
};

/** Style never changes text metrics, so a measurement-only probe container uses one fixed, cheap style. */
const MEASURE_PROPS: ShapeProps = {
  strokeColor: "#000000",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  roundness: null,
};

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** Any non-finite number coming from a corrupt element or settings blob collapses to a usable default. */
const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

// Generic in the element type so `Array.prototype.find` keeps narrowing over OrderedExcalidrawElement too.
const isTextElement = <T extends ExcalidrawElement>(el: T | null | undefined): el is T & ExcalidrawTextElement =>
  !!el && el.type === "text";

const isLinearElement = <T extends ExcalidrawElement>(el: T | null | undefined): el is T & ExcalidrawLinearElement =>
  !!el && (el.type === "line" || el.type === "arrow");

/**
 * The module's single failure boundary. A throw from the library means its text metrics are gone, which cannot
 * happen in the browser this module is contracted to run in; if it ever does, the caller gets its own elements
 * back untouched rather than a half-laid-out scene.
 */
function guarded<T>(what: string, fallback: T, body: () => T): T {
  try {
    return body();
  } catch (err) {
    console.warn(`fit: ${what} failed, leaving the elements unchanged`, err);
    return fallback;
  }
}

function resolveOptions(opts?: FitOptions) {
  const maxFontSize = clamp(Math.round(num(opts?.maxFontSize, 96)), 1, FONT_SIZE_CEILING);
  const minFontSize = clamp(Math.round(num(opts?.minFontSize, 10)), 1, maxFontSize);
  const lineMaxFontSize = clamp(Math.round(num(opts?.lineMaxFontSize, 36)), minFontSize, FONT_SIZE_CEILING);
  const lineMinFontSize = clamp(Math.round(num(opts?.lineMinFontSize, 14)), 1, lineMaxFontSize);
  return { maxFontSize, minFontSize, lineMaxFontSize, lineMinFontSize };
}

/** Matches `App.getCurrentItemRoundness`: rectangles use the adaptive radius, everything else proportional. */
function roundnessFor(type: string, roundness: StyleSnapshot["roundness"] | null): ShapeProps["roundness"] {
  if (roundness !== "round") {
    return null;
  }
  return { type: type === "rectangle" ? ROUNDNESS.ADAPTIVE_RADIUS : ROUNDNESS.PROPORTIONAL_RADIUS };
}

/**
 * Props for a shape or for the probe that stands in for one. A new shape takes the user's style snapshot (whose
 * roundness is the appState string); a probe of an element the user already drew must copy that element's own
 * style, or the probe measures a different shape than the one on the canvas.
 */
function shapeProps(src: StyleSnapshot | ExcalidrawElement, type: string, strokeStyle: StrokeStyle): ShapeProps {
  const roundness = src.roundness;
  return {
    strokeColor: src.strokeColor,
    backgroundColor: src.backgroundColor,
    fillStyle: src.fillStyle,
    strokeWidth: num(src.strokeWidth, 1),
    strokeStyle,
    roughness: num(src.roughness, 1),
    opacity: clamp(num(src.opacity, 100), 0, 100),
    roundness: typeof roundness === "object" && roundness !== null
      ? { type: roundness.type }
      : roundnessFor(type, roundness),
  };
}

/**
 * The look of a region MARKER: the founder's own stroke colour, so it reads as theirs, but thin, faint, dashed and
 * never filled — scaffolding, not ink. Roundness is null so the marker's box is exactly the region's box.
 */
function markerProps(strokeColor: string, roughness: number): ShapeProps {
  return {
    strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: MARKER_STROKE_WIDTH,
    strokeStyle: "dashed",
    roughness: num(roughness, 1),
    opacity: MARKER_OPACITY,
    roundness: null,
  };
}

/**
 * Stamps an element as a region marker. The mark lives in `customData` because that is what survives storage: a
 * marker found in a reloaded scene is always a leftover (a committed take deletes its own marker), which is how
 * persist.ts can sweep one without knowing anything about the take that made it.
 */
const stamp = (el: ExcalidrawElement): ExcalidrawElement =>
  newElementWith(el, { customData: { ...el.customData, ...VOICE_REGION_CUSTOM_DATA } });

/**
 * The `customData` a take's TEXT carries: the failure stamp while it shows "⚠ STT", the interim stamp while it
 * shows words that are still being spoken, and NEITHER once the transcript has landed. Both stamps exist so that
 * `persist.ts` can sweep a reload's litter without reading text content, and both are stripped unconditionally
 * here: a commit after a failed retry, or after an interim preview, must leave a clean element behind or the next
 * reload would eat the founder's words.
 * Computed as part of the one patch that writes the text, so the version counter still bumps exactly once.
 */
function textCustomData(
  el: ExcalidrawElement,
  stamps: { failed?: boolean; interim?: boolean } = {},
): Record<string, unknown> {
  const { voiceFailed: _f, voiceInterim: _i, ...rest } = (el.customData ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    ...(stamps.failed ? VOICE_FAILED_CUSTOM_DATA : {}),
    ...(stamps.interim ? VOICE_INTERIM_CUSTOM_DATA : {}),
  };
}

/**
 * Does this text already carry words the founder said? A LATER failure may never overwrite them (round 4c): the
 * committed transcript lives only on the canvas, so writing "⚠ STT" over it destroyed it for good once the page
 * reloaded. A placeholder dot, an empty text, an earlier warning and an INTERIM PREVIEW are all fair game.
 *
 * The preview is words, but it is not a copy of anything: it is this take's own cosmetic guess, `persist.ts`
 * deletes it on the next reload, and the take it belongs to is the one that just failed. Before round 5b a final
 * transcript that failed after a preview had landed was reported NOWHERE — markFailed returned [] and the region
 * kept half a sentence at 45 % that no later path could take back (the entry is `failed`, so renderEntry, the
 * animation tick and the disarm sweep all leave it alone).
 */
function hasLandedTranscript(text: ExcalidrawTextElement): boolean {
  const content = String(text.originalText ?? text.text ?? "").trim();
  if (!content || isInterimText(text)) {
    return false;
  }
  return !PLACEHOLDER_FRAMES.includes(content as (typeof PLACEHOLDER_FRAMES)[number]) &&
    !content.startsWith(FAILED_TEXT);
}

/** Once the text is placed the marker leaves the scene in the SAME update; an absent marker is normal, not an error. */
const removeMarker = (marker: ExcalidrawElement | null | undefined): ExcalidrawElement[] =>
  marker && !marker.isDeleted ? [newElementWith(marker, { isDeleted: true })] : [];

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
    return {
      x: Math.min(num(shape.start?.x), num(shape.end?.x)),
      y: Math.min(num(shape.start?.y), num(shape.end?.y)),
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

/** One text element through the library — the only text factory and the only text measurement in this module. */
function newText(props: { text: string; fontSize: number; label: LabelProps; x?: number; y?: number }) {
  const built = convertToExcalidrawElements([
    {
      type: "text",
      x: num(props.x),
      y: num(props.y),
      text: props.text,
      fontSize: clamp(Math.round(num(props.fontSize, 20)), 1, FONT_SIZE_CEILING),
      fontFamily: props.label.fontFamily,
      strokeColor: props.label.strokeColor,
      opacity: props.label.opacity,
    },
  ]);
  const textEl = built.find(isTextElement);
  if (!textEl) {
    throw new Error("the library produced no text element");
  }
  return textEl;
}

/** Builds a container + bound text through the library, i.e. the editor's own layout for that pair. */
function probeBoundPair(probe: Probe, text: string, fontSize: number): BoundPair {
  const built = convertToExcalidrawElements([
    {
      type: probe.type,
      ...probe.geom,
      ...probe.props,
      label: { text, fontSize, ...probe.label, textAlign: "center", verticalAlign: "middle" },
    } as unknown as ExcalidrawElementSkeleton,
  ]);
  const textEl = built.find(isTextElement);
  const container = built.find((el) => el.id === textEl?.containerId);
  if (!textEl || !container) {
    throw new Error("the library produced no bound text pair");
  }
  return { container, text: textEl };
}

const containerUnchanged = (built: ExcalidrawElement, geom: Geometry) =>
  Math.abs(built.width - geom.width) <= FIT_TOLERANCE && Math.abs(built.height - geom.height) <= FIT_TOLERANCE;

/**
 * Largest integer font size in [minFontSize, maxFontSize] whose wrapped text does not grow the container.
 * The floor is probed first: if even that grows the container, that growth is what the user gets (G4 documents
 * it) and the search is over. Above the floor the fit is monotone in the font size, so a binary search is exact.
 */
function fitBoundText(probe: Probe, text: string, minFontSize: number, maxFontSize: number): BoundPair {
  let best = probeBoundPair(probe, text, minFontSize);
  if (!containerUnchanged(best.container, probe.geom)) {
    return best;
  }
  let lo = minFontSize + 1;
  let hi = Math.max(minFontSize, maxFontSize);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pair = probeBoundPair(probe, text, mid);
    if (containerUnchanged(pair.container, probe.geom)) {
      best = pair;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
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
  return { mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, dx, dy, length: Math.hypot(dx, dy) };
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
    return endpointsToGeometry(
      rotate({ x: num(el.x) + first.x, y: num(el.y) + first.y }, cx, cy, angle),
      rotate({ x: num(el.x) + last.x, y: num(el.y) + last.y }, cx, cy, angle),
    );
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
  const label: LabelProps = { fontFamily: fontFamily as FontFamilyValues, strokeColor: "#000000", opacity: 100 };
  const { width, height } = newText({ text: String(text ?? "").replace(/\s+/g, " "), fontSize, label });
  return { width, height };
}

/**
 * Wraps `content` to `width` with the library's own wrapping — reachable only through a bound label, because
 * `convertToExcalidrawElements` never wraps a free text element — and reports the block that comes out. The probe
 * container is a rectangle wide enough that the max width of its label is exactly `width`.
 */
function wrapToWidth(content: string, fontSize: number, fontFamily: FontFamilyValues, width: number) {
  const probe: Probe = {
    type: "rectangle",
    geom: { x: 0, y: 0, width: width + BOUND_TEXT_PADDING * 2, height: 1, angle: 0 },
    props: MEASURE_PROPS,
    label: { fontFamily, strokeColor: "#000000", opacity: 100 },
  };
  const { text, height } = probeBoundPair(probe, content, fontSize).text;
  return { text, height };
}

/**
 * Places a transcript along a line: centred on the midpoint, sitting just above it, rotated with the slope.
 * One line at the largest size in [minFontSize, maxFontSize] whose width fits the line; when even minFontSize is
 * too wide, the text wraps to the line's length at minFontSize and the block grows upward from the line instead
 * (R5 — shrinking to 10 px and spilling past both ends was unreadable on the wall).
 */
function layoutLineText(g: LineGeometry, content: string, fontFamily: FontFamilyValues, min: number, max: number) {
  const single = content.replace(/\s+/g, " ").trim() || content;
  const length = Math.max(1, g.length);
  let fitted = 0;
  let metrics = { width: 0, height: 0 };
  let lo = min;
  let hi = Math.max(min, max);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = measureOnly(single, mid, fontFamily);
    if (m.width <= length) {
      fitted = mid;
      metrics = m;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const wrapped = fitted ? null : wrapToWidth(single, min, fontFamily, length);
  const width = wrapped ? length : metrics.width;
  const height = wrapped ? wrapped.height : metrics.height;
  const normal = upperNormal(g);
  const offset = height / 2 + LINE_TEXT_GAP;
  return {
    text: wrapped ? wrapped.text : single,
    originalText: single,
    fontSize: fitted || min,
    width,
    height,
    x: g.mid.x + normal.x * offset - width / 2,
    y: g.mid.y + normal.y * offset - height / 2,
    angle: readableAngle(g.dx, g.dy),
    // A wrapped block keeps the width it was wrapped to, so the editor re-wraps to it if the text is edited.
    autoResize: !wrapped,
  };
}

/**
 * Puts a line layout on a text element: the caller's own on commit, a fresh one for a placeholder. `customData`
 * carries (or clears) the failure stamp when the caller knows which it is; a placeholder passes nothing.
 */
function applyLineLayout(
  text: ExcalidrawTextElement | null,
  layout: LineTextLayout,
  label: LabelProps,
  customData?: Record<string, unknown>,
) {
  const base = text ?? newText({ text: layout.text, fontSize: layout.fontSize, label, x: layout.x, y: layout.y });
  return newElementWith(base, {
    ...(customData === undefined ? {} : { customData }),
    text: layout.text,
    originalText: layout.originalText,
    fontSize: layout.fontSize,
    width: layout.width,
    height: layout.height,
    x: layout.x,
    y: layout.y,
    angle: layout.angle as ExcalidrawTextElement["angle"],
    autoResize: layout.autoResize,
    textAlign: "center",
    verticalAlign: "middle",
    strokeColor: label.strokeColor,
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
  customData?: Record<string, unknown>,
): ExcalidrawTextElement {
  return newElementWith(text, {
    ...(customData === undefined ? {} : { customData }),
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

/**
 * The committed form of a fitted area text: the probed BOUND layout, with the binding cut. Same x/y/size/wrapped
 * lines, `containerId` null and `autoResize` false at the measured width — the library only re-wraps a free text
 * element when autoResize is true, so the block stays where it was measured across a render, a reload and an undo.
 */
function applyFreeLayout(
  text: ExcalidrawTextElement,
  probed: ExcalidrawTextElement,
  originalText: string,
  customData?: Record<string, unknown>,
): ExcalidrawTextElement {
  return newElementWith(text, {
    ...(customData === undefined ? {} : { customData }),
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
    verticalAlign: probed.verticalAlign,
    autoResize: false,
    containerId: null,
    isDeleted: false,
  });
}

/** Placeholder dot size: a comfortable fraction of the shape, never below 12px nor above the user's ceiling. */
function placeholderFontSize(geom: Geometry, maxFontSize: number): number {
  return clamp(
    Math.round(Math.min(geom.width, geom.height) * PLACEHOLDER_HEIGHT_RATIO),
    PLACEHOLDER_MIN_FONT_SIZE,
    maxFontSize,
  );
}

/** Text along a line is never bound to it — a bound label on a linear element is laid out as an arrow label. */
function linePlaceholder(
  lineEl: ExcalidrawElement, shape: StrokeShape, label: LabelProps, minFontSize: number, lineMaxFontSize: number,
): PlaceholderResult {
  const fontSize = clamp(Math.min(lineMaxFontSize, LINE_PLACEHOLDER_FONT_SIZE), minFontSize, FONT_SIZE_CEILING);
  const g = lineGeometry(lineEl, shape);
  const layout = layoutLineText(g, PLACEHOLDER_FRAMES[0], label.fontFamily, fontSize, fontSize);
  const textEl = applyLineLayout(null, layout, label);
  return { elements: [lineEl, textEl], target: { markerId: lineEl.id, textId: textEl.id, shape } };
}

function newLineElement(shape: StrokeShape, props: ShapeProps): ExcalidrawElement {
  const g = shape.kind === "line" ? shape : null;
  const start = { x: num(g?.start?.x), y: num(g?.start?.y) };
  const end = { x: num(g?.end?.x, start.x + 1), y: num(g?.end?.y, start.y) };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const built = convertToExcalidrawElements([
    {
      type: "line",
      x: start.x,
      y: start.y,
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: [[0, 0], [dx, dy]],
      ...props,
    } as unknown as ExcalidrawElementSkeleton,
  ]);
  const lineEl = built.find(isLinearElement);
  if (!lineEl) {
    throw new Error("the library produced no line element");
  }
  return lineEl;
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
  const { x, y, width, height } = geometryOf(el);
  return { kind: el.type === "ellipse" ? "ellipse" : "rectangle", x, y, width, height };
}

function labelOf(src: StyleSnapshot | ExcalidrawElement, fontFamily: FontFamilyValues): LabelProps {
  return { fontFamily, strokeColor: src.strokeColor, opacity: clamp(num(src.opacity, 100), 0, 100) };
}

function buildPlaceholder(shape: StrokeShape, style: StyleSnapshot, opts?: FitOptions): PlaceholderResult {
  return guarded("buildPlaceholder", { elements: [], target: { markerId: "", textId: "", shape } }, () => {
    const { maxFontSize, minFontSize, lineMaxFontSize } = resolveOptions(opts);
    const label = labelOf(style, style.fontFamily);
    if (shape?.kind === "line") {
      const lineEl = stamp(newLineElement(shape, shapeProps(style, "line", "dashed")));
      return linePlaceholder(lineEl, shape, label, minFontSize, lineMaxFontSize);
    }
    const geom = geometryOfShape(shape);
    // A RECTANGLE even for an ellipse stroke: the region is the stroke's bounding box, that is where the text is
    // fitted, and the outline itself is gone the moment the words land — so there is no ellipse to be faithful to.
    const probe: Probe = { type: "rectangle", geom, props: markerProps(style.strokeColor, style.roughness), label };
    // Search down from the wanted size so a shallow box gets a smaller dot rather than being grown.
    const wanted = Math.max(minFontSize, placeholderFontSize(geom, maxFontSize));
    const pair = fitBoundText(probe, PLACEHOLDER_FRAMES[0], minFontSize, wanted);
    return {
      elements: [stamp(pair.container), pair.text],
      target: { markerId: pair.container.id, textId: pair.text.id, shape },
    };
  });
}

function buildPlaceholderFor(container: ExcalidrawElement, style: StyleSnapshot, opts?: FitOptions): PlaceholderResult {
  const shape = shapeOfElement(container);
  // The element the founder just drew with a native tool IS the marker: dashed and stamped, it disappears with
  // the commit like any other region marker.
  const dashed = stamp(newElementWith(container, { strokeStyle: "dashed" as StrokeStyle }));
  const fallback = { elements: [dashed], target: { markerId: container.id, textId: "", shape } };
  return guarded("buildPlaceholderFor", fallback, () => {
    const { maxFontSize, minFontSize, lineMaxFontSize } = resolveOptions(opts);
    const label = labelOf(container, style.fontFamily);
    if (isLinearElement(container)) {
      return linePlaceholder(dashed, shape, label, minFontSize, lineMaxFontSize);
    }
    const geom = geometryOf(container);
    // Measured in the same rectangle a commit is measured in, whatever the founder drew: the words are fitted to
    // the region's bounding box, so fitting the dot to an ellipse's inner box would be a different question.
    const probe: Probe = { type: "rectangle", geom, props: MEASURE_PROPS, label };
    const wanted = Math.max(minFontSize, placeholderFontSize(geom, maxFontSize));
    const pair = fitBoundText(probe, PLACEHOLDER_FRAMES[0], minFontSize, wanted);
    const text = newElementWith(pair.text, { containerId: container.id });
    // Only the marker's LOOK changes: the user's geometry is the user's (CLAUDE.md), and a probe that grew is a
    // throwaway — copying its size onto the founder's own shape would resize a shape they drew.
    const updated = stamp(
      newElementWith(container, {
        strokeStyle: "dashed" as StrokeStyle,
        boundElements: withTextBinding(container.boundElements, text.id),
      }),
    );
    return { elements: [updated, text], target: { markerId: container.id, textId: text.id, shape } };
  });
}

function setPlaceholderFrame(text: ExcalidrawTextElement, frame: number): ExcalidrawTextElement {
  return guarded("setPlaceholderFrame", text, () => {
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
  });
}

/**
 * The transcript, fitted to the REGION and committed as a free text element, with the marker deleted in the same
 * breath. The geometry comes from `target.shape` and never from the marker: a second utterance (or a retry after a
 * ⚠) lands in a region whose marker was already removed by the first commit, and the founder's words must still go
 * where they drew them.
 */
function commitText(
  target: VoiceTarget,
  text: ExcalidrawTextElement,
  transcript: string,
  style: StyleSnapshot,
  marker?: ExcalidrawElement | null,
  opts?: FitOptions,
): ExcalidrawElement[] {
  const live = marker && !marker.isDeleted ? marker : null;
  return guarded("commitText", live ? [live, text] : [text], () => {
    const { maxFontSize, minFontSize, lineMaxFontSize, lineMinFontSize } = resolveOptions(opts);
    const content = String(transcript ?? "").trim();
    if (!content) {
      // The controller is meant to call discard() for this; doing it here keeps an empty result harmless.
      return discard(target, live, text, style);
    }
    const shape = target?.shape ?? (live ? shapeOfElement(live) : undefined);
    const label = labelOf(style, style.fontFamily);
    // Words landing clear the failure stamp in the same patch, so a reload's ghost sweep never eats a transcript.
    const landed = textCustomData(text);
    if (shape?.kind === "line" || isLinearElement(live)) {
      const g = lineGeometry(live, shape);
      const layout = layoutLineText(g, content, style.fontFamily, lineMinFontSize, lineMaxFontSize);
      return [applyLineLayout(text, layout, label, landed), ...removeMarker(live)];
    }
    const geom = shape ? geometryOfShape(shape) : geometryOf(text);
    // Measured in a throwaway rectangle the size of the region: the largest font size the library's own layout
    // fits inside it without growing it. The probe is discarded; only its layout survives, on a free text element.
    const probe: Probe = { type: "rectangle", geom, props: MEASURE_PROPS, label };
    const pair = fitBoundText(probe, content, minFontSize, maxFontSize);
    return [applyFreeLayout(text, pair.text, content, landed), ...removeMarker(live)];
  });
}

/**
 * The words SO FAR, previewed in the region while the founder is still speaking (round 5).
 *
 * Fitted exactly like a commit — same probe, same binary search, same region geometry — so the preview is not a
 * different layout that jumps when the final transcript lands. What differs is that the take is not over: the
 * region MARKER stays, the text keeps its binding to it, it is drawn at `INTERIM_OPACITY`, and it is stamped
 * `customData.voiceInterim` so that (a) a reload sweeps it instead of leaving half a sentence at 45 % on the board
 * and (b) the controller can tell its own preview apart from landed words.
 *
 * An empty interim answer returns [] rather than discarding anything: nothing has been decided yet.
 */
function commitInterim(
  target: VoiceTarget,
  text: ExcalidrawTextElement,
  transcript: string,
  style: StyleSnapshot,
  marker?: ExcalidrawElement | null,
  opts?: FitOptions,
): ExcalidrawElement[] {
  const live = marker && !marker.isDeleted ? marker : null;
  return guarded("commitInterim", [], () => {
    const { maxFontSize, minFontSize, lineMaxFontSize, lineMinFontSize } = resolveOptions(opts);
    const content = String(transcript ?? "").trim();
    if (!content) {
      return [];
    }
    const shape = target?.shape ?? (live ? shapeOfElement(live) : undefined);
    const label = { ...labelOf(style, style.fontFamily), opacity: INTERIM_OPACITY };
    const stamped = textCustomData(text, { interim: true });
    if (shape?.kind === "line" || isLinearElement(live)) {
      const g = lineGeometry(live, shape);
      const layout = layoutLineText(g, content, style.fontFamily, lineMinFontSize, lineMaxFontSize);
      // A line region's text was never bound to the line, so the preview is free text like the placeholder is.
      return [applyLineLayout(text, layout, label, stamped)];
    }
    const geom = shape ? geometryOfShape(shape) : geometryOf(text);
    const probe: Probe = { type: "rectangle", geom, props: MEASURE_PROPS, label };
    const pair = fitBoundText(probe, content, minFontSize, maxFontSize);
    // Bound, not free: the marker is still on the canvas, and a text it lists in `boundElements` whose own
    // containerId is null is a pair the editor would re-lay-out from one side only.
    return live
      ? [applyBoundLayout(text, pair.text, live.id, content, stamped)]
      : [applyFreeLayout(text, pair.text, content, stamped)];
  });
}

/**
 * Puts the animated placeholder back, clearing the interim stamp.
 *
 * The preview above is rendered in the PROVISIONAL region (assign.ts's answer before the pre-roll window has
 * elapsed), and the final answer may be a different region. That region must then be left exactly as it was found,
 * which means recomputing the placeholder's own layout from `target.shape` rather than remembering an element from
 * an earlier frame.
 */
function resetPlaceholder(
  target: VoiceTarget,
  marker: ExcalidrawElement | null,
  text: ExcalidrawTextElement,
  style: StyleSnapshot,
  opts?: FitOptions,
): ExcalidrawElement[] {
  const live = marker && !marker.isDeleted ? marker : null;
  return guarded("resetPlaceholder", [], () => {
    const { maxFontSize, minFontSize, lineMaxFontSize } = resolveOptions(opts);
    const label = labelOf(style, style.fontFamily);
    const shape = target?.shape ?? (live ? shapeOfElement(live) : undefined);
    const cleared = textCustomData(text);
    if (shape?.kind === "line" || isLinearElement(live)) {
      const fontSize = clamp(Math.min(lineMaxFontSize, LINE_PLACEHOLDER_FONT_SIZE), minFontSize, FONT_SIZE_CEILING);
      const g = lineGeometry(live, shape);
      const layout = layoutLineText(g, PLACEHOLDER_FRAMES[0], label.fontFamily, fontSize, fontSize);
      return [applyLineLayout(text, layout, label, cleared)];
    }
    const geom = shape ? geometryOfShape(shape) : geometryOf(text);
    const probe: Probe = { type: "rectangle", geom, props: MEASURE_PROPS, label };
    const wanted = Math.max(minFontSize, placeholderFontSize(geom, maxFontSize));
    const pair = fitBoundText(probe, PLACEHOLDER_FRAMES[0], minFontSize, wanted);
    return live
      ? [applyBoundLayout(text, pair.text, live.id, PLACEHOLDER_FRAMES[0], cleared)]
      : [applyFreeLayout(text, pair.text, PLACEHOLDER_FRAMES[0], cleared)];
  });
}

/**
 * The transcription failed: the warning goes in the region and the marker STAYS dashed, because the retry button
 * needs something the founder can see and point at. A retry that succeeds runs commitText, which removes it.
 *
 * Nothing is written when the text already carries LANDED WORDS (a second utterance into a region whose first take
 * committed, or a retry after a commit): the words are the only copy there is, and reporting a failure is not worth
 * destroying them — the toast, `status.failed` and the retry button carry that news instead (round 4c).
 */
function markFailed(
  target: VoiceTarget, marker: ExcalidrawElement | null, text: ExcalidrawTextElement, style: StyleSnapshot,
): ExcalidrawElement[] {
  const live = marker && !marker.isDeleted ? marker : null;
  return guarded("markFailed", live ? [live, text] : [text], () => {
    if (hasLandedTranscript(text)) {
      return [];
    }
    const shape = target?.shape ?? (live ? shapeOfElement(live) : undefined);
    const label = { ...labelOf(style, style.fontFamily), strokeColor: FAILED_COLOR };
    // The stamp is what persist.ts sweeps on: a warning may be UNBOUND (a line region, or a region whose marker an
    // earlier commit removed), and litter must not be decided by reading the text content.
    const stamped = textCustomData(text, { failed: true });
    if (shape?.kind === "line" || isLinearElement(live)) {
      const g = lineGeometry(live, shape);
      const layout = layoutLineText(g, FAILED_TEXT, style.fontFamily, FAILED_FONT_SIZE, FAILED_FONT_SIZE);
      return [applyLineLayout(text, layout, label, stamped)];
    }
    const geom = shape ? geometryOfShape(shape) : geometryOf(text);
    const probe: Probe = { type: "rectangle", geom, props: MEASURE_PROPS, label };
    const pair = probeBoundPair(probe, FAILED_TEXT, FAILED_FONT_SIZE);
    if (!live) {
      // A first take that failed into a region whose marker is already gone: the warning stands on its own.
      return [applyFreeLayout(text, pair.text, FAILED_TEXT, stamped)];
    }
    return [
      newElementWith(live, {
        strokeStyle: "dashed" as StrokeStyle,
        boundElements: withTextBinding(live.boundElements, target?.textId || text.id),
      }),
      applyBoundLayout(text, pair.text, live.id, FAILED_TEXT, stamped),
    ];
  });
}

/**
 * No speech ever landed in this region. The marker was only ever scaffolding, so BOTH halves leave the scene —
 * round 4a: a shape the founder drew to select a region is not a shape they asked to keep.
 */
function discard(
  _target: VoiceTarget, marker: ExcalidrawElement | null, text: ExcalidrawTextElement, _style: StyleSnapshot,
): ExcalidrawElement[] {
  return [newElementWith(text, { isDeleted: true }), ...removeMarker(marker)];
}

function buildFreeText(at: Point, transcript: string, style: StyleSnapshot, fontSize: number): ExcalidrawTextElement {
  // The one entry point with no caller geometry to hand back, so a library failure throws rather than returning
  // undefined cast as an element; it cannot happen in a browser.
  return newText({
    text: String(transcript ?? ""),
    fontSize,
    label: labelOf(style, style.fontFamily),
    x: num(at?.x),
    y: num(at?.y),
  });
}

/**
 * The fonts every measurement depends on, loaded once.
 *
 * Text metrics are font metrics: a fit made before Excalifont has arrived is made against the fallback font and
 * comes out one or two sizes off, which on a 240x120 region is the difference between "inside the box" and a
 * transcript spilling out of a region whose marker the commit has just deleted. `document.fonts.ready` alone is not
 * enough — the library only registers/loads its webfont when text is first MEASURED, so awaiting `ready` before any
 * measurement resolves immediately and the first real fit is still a fallback fit. So: measure once, then await.
 * Cached, so every later caller gets the same settled promise (the controller awaits it before it arms).
 */
let fontsWarm: Promise<void> | null = null;
function warmFonts(fontFamily = 5): Promise<void> {
  return (fontsWarm ??= (async (): Promise<void> => {
    try {
      measureOnly("font warm up", 20, fontFamily);
      await document.fonts?.ready;
    } catch (err) {
      console.warn("fit: font warm-up failed; the first fit may use fallback metrics", err);
    }
  })());
}

export const fit: FitModule & { measureOnly: typeof measureOnly } = {
  buildPlaceholder,
  buildPlaceholderFor,
  setPlaceholderFrame,
  commitText,
  commitInterim,
  resetPlaceholder,
  markFailed,
  discard,
  warmFonts,
  buildFreeText,
  measureOnly,
};

export { measureOnly };
export default fit;
