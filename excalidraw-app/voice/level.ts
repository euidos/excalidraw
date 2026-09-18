/**
 * level.ts — the ONE display mapping for microphone loudness (gate N12).
 *
 * capture.ts emits RAW RMS (0..1, quiet room ~0.003..0.006, speech ~0.02..0.2) and applies no gain, because a gain
 * chosen inside the capture module is invisible to whatever draws the number: round 2 shipped `onLevel` at RMS×4
 * while the settings panel drew both the bar and the VAD threshold marker on the raw 0..VAD_MAX axis, so the bar
 * read ~4× high and the marker was a line the founder could not aim at.
 *
 * Every surface that draws a level imports this module, so the bar and the marker are the same function of the
 * same unit by construction. Pure — no DOM, no React — so the agreement is unit-testable in-process.
 */
import { FLOOR_MULTIPLIER } from "./vad";

/**
 * Full scale of the meter in RAW RMS. The meter exists to set a VAD threshold, whose slider range is 0.003..0.05,
 * so the axis covers that range and nothing more: loud speech pins the bar at 100%, which is the honest answer to
 * "am I above the line" even though it loses the top of the dynamic range.
 */
export const METER_FULL_SCALE = 0.06;

/** RAW RMS → percentage of the meter's width, clamped into it. */
export function meterPercent(rms: number): number {
  if (!Number.isFinite(rms)) {
    return 0;
  }
  return Math.max(0, Math.min(100, (rms / METER_FULL_SCALE) * 100));
}

/**
 * Full scale of the mic GLYPH in RAW RMS. Measured speech on the wall panel runs 0.08..0.48 peak, i.e. 1.5..8x the
 * meter's 0.06 axis, so drawing the glyph on that axis pinned it at 100% for whole sentences and the "reacts to
 * volume" animation read as an on/off strobe at word boundaries.
 */
export const GLYPH_FULL_SCALE = 0.25;

/**
 * RAW RMS → 0..1 for the mic glyph's fill. A DIFFERENT axis from the meter's on purpose, and the only other one:
 * the meter exists to aim the VAD slider (0.003..0.05), the glyph exists to say "the room is being heard", so it
 * needs the dynamic range of speech instead. Square-root compressed, because loudness is perceived that way and it
 * lifts conversational speech (~0.02 RMS) off the floor: 0.02 → 0.28, 0.08 → 0.57, 0.25 and up → 1.
 */
export function glyphLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) {
    return 0;
  }
  return Math.min(1, Math.sqrt(rms / GLYPH_FULL_SCALE));
}

/**
 * The threshold the VAD actually applies: vad.ts opens an utterance above max(setting, 3 × measured noise floor),
 * so a marker drawn at the setting alone lies in any room louder than a third of it.
 */
export function effectiveThreshold(
  vadThreshold: number,
  noiseFloor = 0,
): number {
  const floor = Number.isFinite(noiseFloor) ? Math.max(0, noiseFloor) : 0;
  return Math.max(vadThreshold, FLOOR_MULTIPLIER * floor);
}

export interface MeterScale {
  /** Width of the level bar, %. */
  bar: number;
  /** Position of the VAD threshold marker, %, on the SAME axis as `bar`. */
  mark: number;
  /** The RAW RMS the marker sits at, for the tooltip / a test that wants the pre-display number. */
  threshold: number;
}

/** Both numbers a level meter draws, from one unit through one mapping. */
export function meterScale(
  rms: number,
  vadThreshold: number,
  noiseFloor = 0,
): MeterScale {
  const threshold = effectiveThreshold(vadThreshold, noiseFloor);
  return { bar: meterPercent(rms), mark: meterPercent(threshold), threshold };
}
