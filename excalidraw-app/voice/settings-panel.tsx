/** Compact settings panel for the voice tool. Plain React; look comes from voice.css + Excalidraw CSS vars. */
import { useEffect, useState } from "react";

import { meterScale } from "./level";

import type { CheckHealth, VoiceSettings } from "./contracts";

/**
 * The mic glyph for the main-menu entry that opens this panel (App.tsx). Sized in `em` because the library's own
 * menu items size their icons off the item's font-size, not a fixed px box.
 */
export const voiceSettingsIcon = (
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <path d="M12 19v3" />
  </svg>
);

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  settings: VoiceSettings;
  onChange: (settings: VoiceSettings) => void;
  checkHealth: CheckHealth;
  /** Live mic level from the capture module: RAW RMS 0..1, the same unit the VAD thresholds against. */
  level: number;
  /** The VAD's measured room tone (RAW RMS), so the marker can be drawn where the VAD actually decides. */
  noiseFloor?: number;
}

type MicOption = { deviceId: string; label: string };
type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "done"; text: string; ok: boolean };

const clamp = (v: number, lo: number, hi: number, fallback: number) =>
  Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

/**
 * The languages offered, in the order they are drawn. ko/en only (round 4b, founder request 4): the STT server
 * enforces the same allow-list (`STT_LANGUAGES`) and restricts auto-detect to it, so "auto" can no longer answer a
 * Korean utterance in Japanese. Values must stay a subset of settings.ts ALLOWED_LANGUAGES, which normalises a
 * stored "ja"/"zh" back to auto.
 */
const LANGUAGES: Array<[string, string]> = [
  ["", "auto"],
  ["ko", "한국어 (ko)"],
  ["en", "English (en)"],
];

export function SettingsPanel({
  open,
  onClose,
  settings,
  onChange,
  checkHealth,
  level,
  noiseFloor = 0,
}: SettingsPanelProps) {
  const [mics, setMics] = useState<MicOption[]>([]);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  /**
   * Escape, or a tap anywhere outside the panel, closes it. The wall panel has no keyboard and no console: without
   * this the only way out is the small ✕, and a stray tap on the canvas behind the panel does nothing at all.
   * `pointerdown` in the capture phase, so a tap that lands on the canvas closes the panel before it draws.
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !(target instanceof Element && target.closest(".voice-settings"))
      ) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTest({ kind: "idle" });
    let cancelled = false;
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) => {
        if (cancelled) {
          return;
        }
        setMics(
          devices
            .filter((d) => d.kind === "audioinput")
            // labels are empty until mic permission is granted, so fall back to a stable ordinal
            .map((d, i) => ({
              deviceId: d.deviceId,
              label: d.label || `Microphone ${i + 1}`,
            })),
        );
      })
      .catch((err) => console.warn("[voice] could not list microphones", err));
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const patch = (p: Partial<VoiceSettings>) => onChange({ ...settings, ...p });
  const meter = meterScale(level, settings.vadThreshold, noiseFloor);

  const runTest = async () => {
    setTest({ kind: "testing" });
    try {
      const r = await checkHealth(settings.sttUrl);
      setTest({
        kind: "done",
        ok: r.ok,
        text: r.ok
          ? `ok${r.warm ? " · warm" : " · cold"}${
              r.model ? ` · ${r.model}` : ""
            }`
          : "unreachable",
      });
    } catch (err) {
      setTest({
        kind: "done",
        ok: false,
        text: err instanceof Error ? err.message : "failed",
      });
    }
  };

  return (
    <div className="voice-settings" role="dialog" aria-label="Voice settings">
      <div className="voice-settings__header">
        <span className="voice-settings__title">Voice settings</span>
        <button
          type="button"
          className="voice-settings__close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <label className="voice-settings__row">
        <span>STT URL</span>
        <input
          type="text"
          value={settings.sttUrl}
          spellCheck={false}
          onChange={(e) => patch({ sttUrl: e.target.value })}
        />
      </label>

      <label className="voice-settings__row">
        <span>Language</span>
        <select
          value={settings.language}
          onChange={(e) => patch({ language: e.target.value })}
        >
          {LANGUAGES.map(([value, label]) => (
            <option key={value || "auto"} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="voice-settings__row">
        <span>Prompt</span>
        <input
          type="text"
          value={settings.prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
        />
      </label>

      <label className="voice-settings__row">
        <span>Microphone</span>
        <select
          value={settings.deviceId}
          onChange={(e) => patch({ deviceId: e.target.value })}
        >
          <option value="">Default</option>
          {mics.map((m) => (
            <option key={m.deviceId} value={m.deviceId}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label className="voice-settings__row">
        <span>Max font size</span>
        <input
          type="number"
          min={10}
          max={400}
          value={settings.maxFontSize}
          onChange={(e) =>
            patch({
              maxFontSize: Number(e.target.value) || settings.maxFontSize,
            })
          }
        />
      </label>

      <label className="voice-settings__row">
        <span>Line max font size</span>
        <input
          type="number"
          min={10}
          max={400}
          value={settings.lineMaxFontSize}
          onChange={(e) =>
            patch({
              lineMaxFontSize:
                Number(e.target.value) || settings.lineMaxFontSize,
            })
          }
        />
      </label>

      <label className="voice-settings__row">
        <span>Line min font size</span>
        <input
          type="number"
          min={6}
          max={400}
          value={settings.lineMinFontSize}
          onChange={(e) =>
            patch({
              lineMinFontSize:
                Number(e.target.value) || settings.lineMinFontSize,
            })
          }
        />
      </label>

      <label className="voice-settings__row">
        <span>Pre-roll (ms)</span>
        <input
          type="number"
          min={0}
          max={4000}
          step={100}
          value={settings.preRollMs}
          onChange={(e) =>
            patch({
              preRollMs: clamp(
                Number(e.target.value),
                0,
                4000,
                settings.preRollMs,
              ),
            })
          }
        />
      </label>
      <p className="voice-settings__help">
        speech may start this long before its stroke
      </p>

      <label className="voice-settings__row">
        <span>Interim results every (ms)</span>
        <input
          type="number"
          min={0}
          max={5000}
          step={100}
          value={settings.interimMs}
          onChange={(e) =>
            patch({
              interimMs: clamp(
                Number(e.target.value),
                0,
                5000,
                settings.interimMs,
              ),
            })
          }
        />
      </label>
      <p className="voice-settings__help">
        words appear while you are still talking; 0 turns it off
      </p>

      <label className="voice-settings__row">
        <span>VAD threshold</span>
        <span className="voice-settings__slider">
          {/* A range, not a number field: on the wall panel there is no keyboard, and a half-typed "0.0" would clamp away. */}
          <input
            type="range"
            min={0.003}
            max={0.05}
            step={0.001}
            value={settings.vadThreshold}
            onChange={(e) =>
              patch({
                vadThreshold: clamp(
                  Number(e.target.value),
                  0.003,
                  0.05,
                  settings.vadThreshold,
                ),
              })
            }
          />
          <output>{settings.vadThreshold.toFixed(3)}</output>
        </span>
      </label>
      <div className="voice-settings__row">
        <span>Level</span>
        <div
          className="voice-meter"
          role="presentation"
          data-testid="voice-meter"
        >
          {/* One mapping, one unit (gate N12): src/level.ts turns the RAW RMS the capture emits into both numbers,
              and the marker sits at the threshold the VAD really uses — max(setting, 3 x room floor). */}
          <div
            className="voice-meter__fill"
            style={{ width: `${meter.bar}%` }}
            data-level={meter.bar.toFixed(1)}
          />
          <div
            className="voice-meter__mark"
            style={{ left: `${meter.mark}%` }}
            data-threshold={meter.threshold.toFixed(4)}
            title={`VAD opens above ${meter.threshold.toFixed(3)} RMS`}
          />
        </div>
      </div>

      <label className="voice-settings__row voice-settings__row--check">
        <span>Warm mic on boot</span>
        <input
          type="checkbox"
          checked={settings.warmMicOnBoot}
          onChange={(e) => patch({ warmMicOnBoot: e.target.checked })}
        />
      </label>

      <div className="voice-settings__actions">
        <button
          type="button"
          onClick={runTest}
          disabled={test.kind === "testing"}
        >
          {test.kind === "testing" ? "Testing…" : "Test STT"}
        </button>
        {test.kind === "done" && (
          <span
            className={`voice-settings__result${
              test.ok ? "" : " voice-settings__result--bad"
            }`}
          >
            {test.text}
          </span>
        )}
        <button
          type="button"
          className="voice-settings__done"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
