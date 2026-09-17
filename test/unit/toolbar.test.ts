/**
 * Toolbar rendering gates. `buttonTitle` is pure string formatting, so the tooltip — the wall panel's only console
 * — is gated here rather than through a browser; the toast half of the same gate (N10) is e2e G5b.
 */
import { describe, expect, it } from "vitest";

import type { VoiceStatus } from "../../src/contracts";
import { buttonTitle } from "../../src/toolbar";

describe("buttonTitle — the toolbar says how many transcripts were thrown away", () => {
  const status = (patch: Partial<VoiceStatus> = {}): VoiceStatus => ({
    mode: "idle",
    recording: false,
    pending: 0,
    failed: 0,
    mic: "ok",
    level: 0,
    maxPendingSeen: 0,
    completed: 0,
    utterances: 0,
    orphans: 0,
    dropped: 0,
    ...patch,
  });

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
