/**
 * Stored-settings normalisation. The one gate that matters here is the LANGUAGE allow-list (round 4b, founder
 * request 4): ja/zh were offered for three rounds, so a wall panel that has ever been set to Japanese still has
 * "ja" in localStorage — and the STT server now answers an explicit ja with 400, which would turn every take into
 * a ⚠ until someone opened the panel. loadSettings has to heal that value, not just stop offering it.
 *
 * `localStorage` is stubbed rather than pulled in through jsdom: settings.ts touches nothing else of the DOM, and a
 * test environment is a dependency (CLAUDE.md "Never": no casual npm additions).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../../src/contracts";
import { ALLOWED_LANGUAGES, loadSettings, saveSettings } from "../../src/settings";

const KEY = "voice-settings";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  key(): string | null {
    return null;
  }
  get length(): number {
    return this.map.size;
  }
}

const store = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });

const stored = (patch: Record<string, unknown>): void =>
  store.setItem(KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...patch }));

describe("loadSettings — the language allow-list", () => {
  beforeEach(() => store.clear());

  it("offers exactly auto, ko and en", () => {
    expect([...ALLOWED_LANGUAGES]).toEqual(["ko", "en"]);
  });

  it("keeps a language that is still enabled", () => {
    for (const language of ALLOWED_LANGUAGES) {
      stored({ language });
      expect(loadSettings().language).toBe(language);
    }
  });

  it("heals a retired language back to auto instead of posting it to a server that refuses it", () => {
    for (const language of ["ja", "zh", "zh-CN", "JA"]) {
      stored({ language });
      expect(loadSettings().language, language).toBe("");
    }
  });

  it("treats a non-string or absent language as auto", () => {
    stored({ language: 7 });
    expect(loadSettings().language).toBe("");
    store.setItem(KEY, JSON.stringify({ sttUrl: "http://x" }));
    expect(loadSettings().language).toBe("");
  });

  it("normalises on the way OUT too: a patched-in bad value is never persisted", () => {
    saveSettings({ ...DEFAULT_SETTINGS, language: "ja" });
    expect(JSON.parse(store.getItem(KEY)!).language).toBe("");
    expect(loadSettings().language).toBe("");
  });

  it("clamps a negative interim interval to off rather than spinning the preview timer", () => {
    store.setItem(KEY, JSON.stringify({ ...DEFAULT_SETTINGS, interimMs: -500 }));
    expect(loadSettings().interimMs).toBe(0);
    store.setItem(KEY, JSON.stringify({ ...DEFAULT_SETTINGS, interimMs: "soon" }));
    expect(loadSettings().interimMs, "a non-number falls back to the default").toBe(DEFAULT_SETTINGS.interimMs);
  });

  it("leaves every other field alone", () => {
    stored({ language: "ja", sttUrl: "http://example:1", maxFontSize: 42, warmMicOnBoot: false });
    const s = loadSettings();
    expect(s.sttUrl).toBe("http://example:1");
    expect(s.maxFontSize).toBe(42);
    expect(s.warmMicOnBoot).toBe(false);
  });
});
