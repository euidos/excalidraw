/**
 * Toolbar rendering gates. `buttonTitle` is pure string formatting, so the tooltip — the wall panel's only console
 * — is gated here rather than through a browser; the toast half of the same gate (N10) is e2e G5b.
 */
import { describe, expect, it } from "vitest";

import type { VoiceStatus } from "../../src/contracts";
import { METER_FULL_SCALE } from "../../src/level";
import { buttonTitle, buttonVisualState } from "../../src/toolbar";

const base = (patch: Partial<VoiceStatus> = {}): VoiceStatus => ({
  mode: "idle",
  recording: false,
  pending: 0,
  failed: 0,
  mic: "ok",
  level: 0,
  speaking: false,
  maxPendingSeen: 0,
  completed: 0,
  utterances: 0,
  orphans: 0,
  dropped: 0,
  ...patch,
});

describe("buttonVisualState — the mic glyph says whether the microphone is hearing anything", () => {
  it("is a static outline while idle: no armed class, no fill", () => {
    const v = buttonVisualState(base());
    expect(v.classes["voice-tool--armed"]).toBe(false);
    expect(v.level).toBe(0);
  });

  it("ignores a stale level once idle (status.level keeps the last RMS after a disarm)", () => {
    const v = buttonVisualState(base({ mode: "idle", level: METER_FULL_SCALE, speaking: true }));
    expect(v.level).toBe(0);
    expect(v.classes["voice-tool--speaking"]).toBe(false);
  });

  it("fills in proportion to the level while armed, through level.ts's mapping", () => {
    expect(buttonVisualState(base({ mode: "latched", level: METER_FULL_SCALE / 2 })).level).toBeCloseTo(0.5, 6);
    expect(buttonVisualState(base({ mode: "holding", level: METER_FULL_SCALE })).level).toBe(1);
  });

  it("clamps a level louder than the meter's full scale instead of overflowing the capsule", () => {
    expect(buttonVisualState(base({ mode: "latched", level: 1 })).level).toBe(1);
  });

  it("turns the accent on only while an utterance is OPEN — loud room noise is not 'recognized'", () => {
    const loud = buttonVisualState(base({ mode: "latched", recording: true, level: METER_FULL_SCALE }));
    expect(loud.classes["voice-tool--speaking"]).toBe(false);
    const heard = buttonVisualState(
      base({ mode: "latched", recording: true, level: METER_FULL_SCALE, speaking: true }),
    );
    expect(heard.classes["voice-tool--speaking"]).toBe(true);
  });

  it("keeps recording and mic-missing as their own signals", () => {
    expect(buttonVisualState(base({ mode: "latched", recording: true })).classes["voice-tool--recording"]).toBe(
      true,
    );
    for (const mic of ["denied", "missing", "error"] as const) {
      expect(buttonVisualState(base({ mic })).classes["voice-tool--mic-missing"]).toBe(true);
    }
    for (const mic of ["ok", "unknown"] as const) {
      expect(buttonVisualState(base({ mic })).classes["voice-tool--mic-missing"]).toBe(false);
    }
  });
});

describe("buttonTitle — the toolbar says how many transcripts were thrown away", () => {
  const status = base;

  it("says nothing about drops while nothing has been dropped", () => {
    expect(buttonTitle(status())).not.toMatch(/dropped/);
  });

  it("names the count and the text that was filtered", () => {
    const title = buttonTitle(status({ dropped: 2, lastDropped: "Subtitles by amara.org" }));
    expect(title).toContain("dropped 2");
    expect(title).toContain('"Subtitles by amara.org"');
  });

  it("keeps the failure line as well: two different channels, both readable", () => {
    const title = buttonTitle(status({ dropped: 1, lastError: "STT server unreachable" }));
    expect(title).toContain("STT server unreachable");
    expect(title).toContain("dropped 1");
  });
});
