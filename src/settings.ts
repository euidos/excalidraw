/** Persistence + change fan-out for VoiceSettings. localStorage key "voice-settings". */
import { DEFAULT_SETTINGS, type VoiceSettings } from "./contracts";

const KEY = "voice-settings";

type Listener = (s: VoiceSettings) => void;
const listeners = new Set<Listener>();

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);

/** Field-by-field coercion: a hand-edited or half-written localStorage entry must never break boot. */
function coerce(raw: unknown): VoiceSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  const o = raw as Record<string, unknown>;
  return {
    sttUrl: str(o.sttUrl, DEFAULT_SETTINGS.sttUrl),
    language: str(o.language, DEFAULT_SETTINGS.language),
    prompt: str(o.prompt, DEFAULT_SETTINGS.prompt),
    deviceId: str(o.deviceId, DEFAULT_SETTINGS.deviceId),
    maxFontSize: num(o.maxFontSize, DEFAULT_SETTINGS.maxFontSize),
    lineMaxFontSize: num(o.lineMaxFontSize, DEFAULT_SETTINGS.lineMaxFontSize),
    minSegmentMs: num(o.minSegmentMs, DEFAULT_SETTINGS.minSegmentMs),
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
