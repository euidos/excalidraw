/**
 * App.tsx — wires the voice modules around <Excalidraw/>.
 * Nothing here holds Excalidraw state: the controller owns the state machine, persist.ts owns storage,
 * and this file only creates the singletons once the imperative API exists and forwards status to the toolbar.
 */
import { Excalidraw, useHandleLibrary } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSegmentRecorder } from "./audio";
import type {
  SegmentRecorder,
  ToolbarHandle,
  VoiceSettings,
  VoiceStatus,
} from "./contracts";
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
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<ToolbarHandle | null>(null);
  const recorderRef = useRef<SegmentRecorder | null>(null);

  const persister = useMemo(createPersister, []);
  const initialData = useMemo(() => loadInitialData(), []);

  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter });

  // Panel writes go through settings.ts so the controller (which reads loadSettings()) sees them immediately.
  const onSettingsChange = useCallback((next: VoiceSettings) => {
    saveSettings(next);
  }, []);
  useEffect(() => subscribe(setSettings), []);

  useEffect(() => {
    if (!api) {
      return;
    }
    const current = loadSettings();
    const recorder = createSegmentRecorder({ minDurationMs: current.minSegmentMs });
    recorderRef.current = recorder;
    const controller = createVoiceController({
      api,
      recorder,
      transcribe,
      fit,
      recognize: recognizeStroke,
      getSettings: loadSettings,
      onStatus: (status: VoiceStatus) => toolbarRef.current?.update(status),
    });

    // Warm the mic so the first F9 press records instantly. prepare() emits no status of its own, so push the
    // resolved mic state to the toolbar by hand — otherwise a denied/missing mic stays invisible until the first arm.
    void recorder.prepare(current.deviceId || undefined).then(() => {
      toolbarRef.current?.update(controller.getStatus());
    });

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
      recorder.dispose();
      recorderRef.current = null;
      if (window.__excalidrawVoice === debug) {
        delete window.__excalidrawVoice;
      }
    };
  }, [api]);

  // Re-acquire the mic when the device selection changes (cheap and idempotent when it did not).
  useEffect(() => {
    void recorderRef.current?.prepare(settings.deviceId || undefined);
  }, [settings.deviceId]);

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
      />
    </div>
  );
}

/** F9 must reach the controller from the canvas; only the settings panel's own fields swallow it. */
function isPanelInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(".voice-settings") !== null;
}
