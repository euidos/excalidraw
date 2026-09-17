/** Compact settings panel for the voice tool. Plain React; look comes from voice.css + Excalidraw CSS vars. */
import { useEffect, useState } from "react";
import type { CheckHealth, VoiceSettings } from "./contracts";

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  settings: VoiceSettings;
  onChange: (settings: VoiceSettings) => void;
  checkHealth: CheckHealth;
}

type MicOption = { deviceId: string; label: string };
type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "done"; text: string; ok: boolean };

const LANGUAGES: Array<[string, string]> = [
  ["", "auto"],
  ["ko", "한국어 (ko)"],
  ["en", "English (en)"],
  ["ja", "日本語 (ja)"],
  ["zh", "中文 (zh)"],
];

export function SettingsPanel({ open, onClose, settings, onChange, checkHealth }: SettingsPanelProps) {
  const [mics, setMics] = useState<MicOption[]>([]);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

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
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
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

  const runTest = async () => {
    setTest({ kind: "testing" });
    try {
      const r = await checkHealth(settings.sttUrl);
      setTest({
        kind: "done",
        ok: r.ok,
        text: r.ok
          ? `ok${r.warm ? " · warm" : " · cold"}${r.model ? ` · ${r.model}` : ""}`
          : "unreachable",
      });
    } catch (err) {
      setTest({ kind: "done", ok: false, text: err instanceof Error ? err.message : "failed" });
    }
  };

  return (
    <div className="voice-settings" role="dialog" aria-label="Voice settings">
      <div className="voice-settings__header">
        <span className="voice-settings__title">Voice settings</span>
        <button type="button" className="voice-settings__close" onClick={onClose} aria-label="Close">
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
        <select value={settings.language} onChange={(e) => patch({ language: e.target.value })}>
          {LANGUAGES.map(([value, label]) => (
            <option key={value || "auto"} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="voice-settings__row">
        <span>Prompt</span>
        <input type="text" value={settings.prompt} onChange={(e) => patch({ prompt: e.target.value })} />
      </label>

      <label className="voice-settings__row">
        <span>Microphone</span>
        <select value={settings.deviceId} onChange={(e) => patch({ deviceId: e.target.value })}>
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
          onChange={(e) => patch({ maxFontSize: Number(e.target.value) || settings.maxFontSize })}
        />
      </label>

      <label className="voice-settings__row">
        <span>Line max font size</span>
        <input
          type="number"
          min={10}
          max={400}
          value={settings.lineMaxFontSize}
          onChange={(e) => patch({ lineMaxFontSize: Number(e.target.value) || settings.lineMaxFontSize })}
        />
      </label>

      <div className="voice-settings__actions">
        <button type="button" onClick={runTest} disabled={test.kind === "testing"}>
          {test.kind === "testing" ? "Testing…" : "Test STT"}
        </button>
        {test.kind === "done" && (
          <span className={`voice-settings__result${test.ok ? "" : " voice-settings__result--bad"}`}>
            {test.text}
          </span>
        )}
        <button type="button" className="voice-settings__done" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
