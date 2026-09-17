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
import { effectiveThreshold, METER_FULL_SCALE, meterPercent, meterScale } from "../../src/level";

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
