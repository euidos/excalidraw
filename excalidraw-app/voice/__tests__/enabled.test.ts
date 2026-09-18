/**
 * The kill switch. Phase 1 gated its two fork-only surfaces on env vars (VITE_APP_ENABLE_PWA,
 * VITE_APP_ENABLE_TRACKING); the voice tool is the third and much the largest — it injects a button into
 * upstream's toolbar row, adds a main-menu item and asks for the microphone. What is worth pinning is that it is
 * FAIL-OPEN: the e2e suite, the kiosk build and `yarn start` set nothing, and must all still get the tool.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isVoiceEnabled } from "../enabled";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isVoiceEnabled", () => {
  it("is on when nothing is configured — every build that exists today", () => {
    vi.stubEnv("VITE_APP_ENABLE_VOICE", undefined as unknown as string);

    expect(isVoiceEnabled()).toBe(true);
  });

  it('is off for the literal "false", and only that', () => {
    vi.stubEnv("VITE_APP_ENABLE_VOICE", "false");
    expect(isVoiceEnabled()).toBe(false);
  });

  it("stays on for anything else, so a typo cannot silently take the tool away", () => {
    for (const value of ["true", "1", "0", "off", "no", ""]) {
      vi.stubEnv("VITE_APP_ENABLE_VOICE", value);
      expect(isVoiceEnabled()).toBe(true);
    }
  });
});
