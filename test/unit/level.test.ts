/**
 * Gate N12 — the level bar and the VAD threshold marker share ONE scale.
 *
 * Round 2 drew the bar from `onLevel` (RMS × 4, clamped) and the marker from `vadThreshold` (raw RMS) on the same
 * 0..0.06 axis, so a near-silent room (0.0045 RMS) painted a bar at 30% while the marker for the 0.012 threshold
 * sat at 20%: the meter said "you are over the line" about a room the VAD heard as silence. The scale now crosses
 * the module boundary as raw RMS and both numbers come out of one function, which is what these cases pin.
 */
import { describe, expect, it } from "vitest";

import { createVad, FLOOR_MULTIPLIER } from "../../src/vad";
import {
  effectiveThreshold,
  GLYPH_FULL_SCALE,
  glyphLevel,
  METER_FULL_SCALE,
  meterPercent,
  meterScale,
} from "../../src/level";

describe("meterScale — bar and marker are the same function of the same unit", () => {
  it("puts the marker exactly where the bar ends when the room sits on the threshold", () => {
    for (const rms of [0.003, 0.006, 0.012, 0.02, 0.05]) {
      const m = meterScale(rms, rms);
      expect(m.mark, `threshold ${rms} must land on the bar's own end`).toBeCloseTo(m.bar, 10);
    }
  });

  it("orders bar against marker the way the VAD orders level against threshold", () => {
    // The whole point of the meter: "bar past the mark" must mean "the VAD would open an utterance".
    for (const rms of [0.001, 0.004, 0.012, 0.03, 0.2]) {
      for (const threshold of [0.003, 0.012, 0.05]) {
        const m = meterScale(rms, threshold);
        const loudEnough = Math.min(rms, METER_FULL_SCALE) > Math.min(threshold, METER_FULL_SCALE);
        expect(m.bar > m.mark).toBe(loudEnough);
      }
    }
  });

  it("draws the marker at the threshold the VAD really uses, not at the setting alone", () => {
    // vad.ts opens above max(setting, 3 × floor); a noisy room moves the real line up and the marker with it.
    const quiet = meterScale(0.02, 0.012, 0.001);
    expect(quiet.threshold).toBe(0.012);
    const noisy = meterScale(0.02, 0.012, 0.01);
    expect(noisy.threshold).toBe(FLOOR_MULTIPLIER * 0.01);
    expect(noisy.mark).toBeCloseTo(meterPercent(0.03), 10);
    expect(noisy.mark).toBeGreaterThan(quiet.mark);
  });

  it("agrees with vad.ts on where the line is, for the same floor", () => {
    // Property: the helper's threshold is the one the live VAD thresholds against, across a grid of rooms.
    for (const floor of [0, 0.002, 0.005, 0.01, 0.02]) {
      const seed = (): ReturnType<typeof createVad> => {
        const vad = createVad({ threshold: 0.012, onsetMs: 20, hangoverMs: 100 });
        for (let i = 0; i < 10; i++) vad.pushFrame(floor, i); // seed the floor from a room of exactly `floor`
        expect(vad.noiseFloor).toBeCloseTo(floor, 10);
        return vad;
      };
      const line = effectiveThreshold(0.012, seed().noiseFloor);
      // A frame just under the line is silence; one just over it opens an utterance (onsetMs = one frame).
      expect(seed().pushFrame(line * 0.95, 10)).toHaveLength(0);
      expect(seed().pushFrame(line * 1.05, 10).some((e) => e.type === "start")).toBe(true);
      // …and the marker the panel draws for that room sits exactly at the bar height that line produces.
      const m = meterScale(line, 0.012, floor);
      expect(m.mark).toBeCloseTo(m.bar, 10);
    }
  });

  it("clamps into the meter instead of overflowing it", () => {
    expect(meterPercent(-1)).toBe(0);
    expect(meterPercent(Number.NaN)).toBe(0);
    expect(meterPercent(0)).toBe(0);
    expect(meterPercent(METER_FULL_SCALE)).toBe(100);
    expect(meterPercent(0.4), "speech pins the bar rather than escaping the element").toBe(100);
  });
});

/**
 * The mic glyph is a SECOND axis on purpose (round 4c): the meter exists to aim the VAD slider (0.003..0.05) and the
 * glyph exists to say "the room is being heard", so drawing the glyph on the meter's 0.06 full scale pinned it at
 * 100% through whole sentences — measured speech on the wall runs 0.08..0.48 — and the animation the founder asked
 * for read as an on/off strobe at word boundaries instead of a level. Still one function per axis.
 */
describe("glyphLevel — the mic glyph's own display curve", () => {
  it("is 0 at silence and 1 only at its own full scale", () => {
    expect(glyphLevel(0)).toBe(0);
    expect(glyphLevel(-1)).toBe(0);
    expect(glyphLevel(Number.NaN)).toBe(0);
    expect(glyphLevel(GLYPH_FULL_SCALE)).toBe(1);
    expect(glyphLevel(1), "clamped, not overflowing the capsule").toBe(1);
  });

  it("leaves conversational speech mid-scale instead of saturating it", () => {
    // Measured speech on the wall panel: 0.08..0.48 RMS. Every one of these pins the VAD meter at 100%, which is
    // what made the glyph a strobe; on the glyph's own axis they all still have somewhere to grow.
    for (const rms of [0.08, 0.15]) {
      expect(meterPercent(rms), `${rms} saturates the VAD meter`).toBe(100);
      expect(glyphLevel(rms), `${rms} must still have somewhere to grow`).toBeLessThan(0.95);
      expect(glyphLevel(rms)).toBeGreaterThan(0.25);
    }
    // A quiet talker at 0.02 is well off the floor rather than a sliver.
    expect(glyphLevel(0.02)).toBeGreaterThan(0.2);
    expect(glyphLevel(0.02)).toBeLessThan(0.5);
  });

  it("is monotone, so louder always draws more", () => {
    let previous = -1;
    for (const rms of [0, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25]) {
      const level = glyphLevel(rms);
      expect(level).toBeGreaterThan(previous);
      previous = level;
    }
  });

  it("is a different axis from the meter's, which keeps the threshold range", () => {
    expect(GLYPH_FULL_SCALE).toBeGreaterThan(METER_FULL_SCALE);
    expect(meterPercent(0.05), "the slider's top end still fills the bar").toBeCloseTo(83.3, 1);
  });
});
