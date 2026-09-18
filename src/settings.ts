/** Persistence + change fan-out for VoiceSettings. localStorage key "voice-settings". */
import { DEFAULT_SETTINGS, type VoiceSettings } from "./contracts";

const KEY = "voice-settings";

/**
 * The languages the STT server will accept (round 4b: the allow-list is enforced there too, `STT_LANGUAGES`, and an
 * explicit language outside it is answered 400). "" is auto-detect, which the server restricts to this same set.
 *
 * Kept here rather than in the panel because a stored value has to be normalised at LOAD time: the panel is not the
 * only reader of `settings.language` — controller.ts posts it straight to the server — so a localStorage entry left
 * over from when ja/zh were offered would keep selecting a language that is now refused.
 */
export const ALLOWED_LANGUAGES: readonly string[] = ["ko", "en"];

/** Anything outside the allow-list (an old "ja"/"zh", a typo, a non-string) becomes "" = auto. */
const lang = (v: unknown): string =>
  typeof v === "string" && ALLOWED_LANGUAGES.includes(v) ? v : "";

type Listener = (s: VoiceSettings) => void;
const listeners = new Set<Listener>();

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** Field-by-field coercion: a hand-edited or half-written localStorage entry must never break boot. */
function coerce(raw: unknown): VoiceSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  const o = raw as Record<string, unknown>;
  return {
    sttUrl: str(o.sttUrl, DEFAULT_SETTINGS.sttUrl),
    language: lang(o.language),
    prompt: str(o.prompt, DEFAULT_SETTINGS.prompt),
    deviceId: str(o.deviceId, DEFAULT_SETTINGS.deviceId),
    maxFontSize: num(o.maxFontSize, DEFAULT_SETTINGS.maxFontSize),
    lineMaxFontSize: num(o.lineMaxFontSize, DEFAULT_SETTINGS.lineMaxFontSize),
    lineMinFontSize: num(o.lineMinFontSize, DEFAULT_SETTINGS.lineMinFontSize),
    minSegmentMs: num(o.minSegmentMs, DEFAULT_SETTINGS.minSegmentMs),
    preRollMs: num(o.preRollMs, DEFAULT_SETTINGS.preRollMs),
    // Clamped, not just coerced: a negative or absurd value would either spin the interim timer or silently
    // disable the preview, and 0 has to keep meaning "off" rather than "every tick".
    interimMs: Math.max(0, num(o.interimMs, DEFAULT_SETTINGS.interimMs)),
    vadThreshold: num(o.vadThreshold, DEFAULT_SETTINGS.vadThreshold),
    warmMicOnBoot: bool(o.warmMicOnBoot, DEFAULT_SETTINGS.warmMicOnBoot),
  };
}

export function loadSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? coerce(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: VoiceSettings): void {
  const next = coerce(s);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("[voice] could not persist settings", err);
  }
  for (const cb of [...listeners]) {
    try {
      cb(next);
    } catch (err) {
      console.warn("[voice] settings listener failed", err);
    }
  }
}

/** Subscribe to saveSettings calls (same tab) and to edits made in another tab. Returns an unsubscribe. */
export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cb(loadSettings());
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}
