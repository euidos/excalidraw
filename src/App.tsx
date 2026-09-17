/**
 * App.tsx — wires the voice modules around <Excalidraw/>.
 * Nothing here holds Excalidraw state: the controller owns the state machine, capture.ts owns the microphone,
 * persist.ts owns storage, and this file only creates the singletons once the imperative API exists and forwards
 * status to the toolbar.
 */
import { Excalidraw, useHandleLibrary } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assignUtterance } from "./assign";
import { createVoiceCapture } from "./capture";
import type { ToolbarHandle, VoiceSettings, VoiceStatus } from "./contracts";
import type { VoiceCapture } from "./contracts-capture";
import { createVoiceController } from "./controller";
import { fit } from "./fit";
import { createPersister, libraryAdapter, loadInitialData } from "./persist";
import { SettingsPanel } from "./settings-panel";
import { loadSettings, saveSettings, subscribe } from "./settings";
import { recognizeStroke } from "./stroke";
import { checkHealth, transcribe } from "./stt";
import { mountVoiceToolbarButton } from "./toolbar";
import "./voice.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const UI_OPTIONS = {
  canvasActions: {
    loadScene: true,
    export: { saveFileToDisk: true },
    saveAsImage: true,
    toggleTheme: true,
  },
} as const;

const GEAR_STYLE: CSSProperties = {
  width: "2.25rem",
  height: "2.25rem",
  border: "none",
  borderRadius: "var(--border-radius-lg, 0.5rem)",
  background: "var(--island-bg-color, #fff)",
  boxShadow: "var(--shadow-island, 0 1px 4px rgba(0,0,0,0.16))",
  color: "var(--color-on-surface, #1b1b1f)",
  cursor: "pointer",
  fontSize: "1rem",
  lineHeight: 1,
};

/** The vanilla app persists the UI language under this key; undefined lets the library auto-detect. */
const langCode = (() => {
  try {
    const raw = localStorage.getItem("i18n-lang");
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
})();
const initialLangCode = typeof langCode === "string" && langCode ? langCode : undefined;

export default function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [settings, setSettings] = useState<VoiceSettings>(() => loadSettings());
  const [panelOpen, setPanelOpen] = useState(false);
  const [level, setLevel] = useState(0);
  /** The VAD's room tone, read alongside the level so the panel's threshold marker matches the VAD's real line. */
  const [noiseFloor, setNoiseFloor] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<ToolbarHandle | null>(null);
  const captureRef = useRef<VoiceCapture | null>(null);
  /** The deviceId the live capture was built for, so a settings write that did not change it re-acquires nothing. */
  const preparedDeviceRef = useRef<string | null>(null);
  /** Read inside capture.onLevel: the meter is a prop of the panel, so a closed panel must not re-render the app. */
  const panelOpenRef = useRef(false);

  const persister = useMemo(createPersister, []);
  const initialData = useMemo(() => loadInitialData(), []);

  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter });

  // Panel writes go through settings.ts so the controller (which reads loadSettings()) sees them immediately.
  const onSettingsChange = useCallback((next: VoiceSettings) => {
    saveSettings(next);
  }, []);
  useEffect(() => subscribe(setSettings), []);

  useEffect(() => {
    panelOpenRef.current = panelOpen;
    if (!panelOpen) {
      setLevel(0);
    }
  }, [panelOpen]);

  useEffect(() => {
    if (!api) {
      return;
    }
    const current = loadSettings();
    const capture = createVoiceCapture({
      vad: { threshold: current.vadThreshold, minUtteranceMs: current.minSegmentMs },
    });
    captureRef.current = capture;
    preparedDeviceRef.current = current.deviceId;
    // Assigned BEFORE the controller, which chains rather than replaces the handler it finds: the toolbar reads the
    // level off VoiceStatus, and only the open settings panel needs it as React state.
    capture.onLevel = (rms: number) => {
      if (panelOpenRef.current) {
        // RAW RMS straight through: the display gain belongs to the surface that draws it (src/level.ts).
        setLevel(rms);
        setNoiseFloor(capture.noiseFloor);
      }
    };

    const controller = createVoiceController({
      api,
      capture,
      assign: assignUtterance,
      transcribe,
      fit,
      recognize: recognizeStroke,
      getSettings: loadSettings,
      onStatus: (status: VoiceStatus) => toolbarRef.current?.update(status),
    });

    // Warm the mic so the first F9 press records instantly. The e2e turns this off to time its fixtures; without it
    // nothing touches the microphone until the controller arms.
    if (current.warmMicOnBoot) {
      void capture.prepare(current.deviceId || undefined).then(() => {
        toolbarRef.current?.update(controller.getStatus());
      });
    }

    let cancelled = false;
    let poll: ReturnType<typeof setTimeout> | null = null;
    const mountToolbar = () => {
      if (cancelled) {
        return;
      }
      const root = wrapperRef.current?.querySelector<HTMLElement>(".excalidraw");
      if (root && root.querySelector(".App-toolbar")) {
        toolbarRef.current = mountVoiceToolbarButton(root, {
          onToggle: () => controller.toggleLatch(),
          onRetry: () => controller.retryFailed(),
          onOpenSettings: () => setPanelOpen(true),
        });
        toolbarRef.current.update(controller.getStatus());
        return;
      }
      poll = setTimeout(mountToolbar, 100);
    };
    mountToolbar();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F9" || isPanelInput(event.target)) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        controller.pressStart();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "F9" || isPanelInput(event.target)) {
        return;
      }
      event.preventDefault();
      controller.pressEnd();
    };
    const onBlur = () => controller.pressEnd();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);

    const debug = {
      api,
      controller,
      capture,
      fit,
      recognize: recognizeStroke,
      status: () => controller.getStatus(),
      settings: loadSettings,
      setSettings: (patch: Partial<VoiceSettings>) => saveSettings({ ...loadSettings(), ...patch }),
    };
    window.__excalidrawVoice = debug;

    return () => {
      cancelled = true;
      if (poll !== null) {
        clearTimeout(poll);
      }
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      toolbarRef.current?.unmount();
      toolbarRef.current = null;
      controller.dispose();
      capture.dispose();
      captureRef.current = null;
      preparedDeviceRef.current = null;
      if (window.__excalidrawVoice === debug) {
        delete window.__excalidrawVoice;
      }
    };
  }, [api]);

  // Re-acquire the mic when the device selection changes. While the mic is still untouched ("unknown") there is
  // nothing to switch: the controller prepares the live deviceId itself when it arms.
  useEffect(() => {
    const capture = captureRef.current;
    if (!capture || preparedDeviceRef.current === settings.deviceId) {
      return;
    }
    preparedDeviceRef.current = settings.deviceId;
    if (capture.mic !== "unknown") {
      void capture.prepare(settings.deviceId || undefined);
    }
  }, [settings.deviceId]);

  // VAD parameters are live; a new capture is built with these already applied, so the mount run is a no-op.
  useEffect(() => {
    captureRef.current?.setVad({
      threshold: settings.vadThreshold,
      minUtteranceMs: settings.minSegmentMs,
    });
  }, [settings.vadThreshold, settings.minSegmentMs]);

  const renderTopRightUI = useCallback(
    () => (
      <button
        type="button"
        // Styled inline: voice.css belongs to the toolbar module and carries no rule for this button.
        style={GEAR_STYLE}
        data-testid="voice-settings-gear"
        title="Voice settings"
        aria-label="Voice settings"
        onClick={() => setPanelOpen((open) => !open)}
      >
        ⚙
      </button>
    ),
    [],
  );

  return (
    <div ref={wrapperRef} style={{ height: "100%", width: "100%" }}>
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={setApi}
        onChange={persister.onChange}
        langCode={initialLangCode}
        UIOptions={UI_OPTIONS}
        renderTopRightUI={renderTopRightUI}
      />
      <SettingsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        settings={settings}
        onChange={onSettingsChange}
        checkHealth={checkHealth}
        level={level}
        noiseFloor={noiseFloor}
      />
    </div>
  );
}

/** F9 must reach the controller from the canvas; only the settings panel's own fields swallow it. */
function isPanelInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(".voice-settings") !== null;
}
