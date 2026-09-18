/**
 * VoiceTool.tsx — wires the voice modules into excalidraw-app.
 *
 * This is the port of `whiteboard/src/App.tsx`'s wiring half: the wrapper owned the whole app, this component owns
 * nothing but the voice singletons. Everything it needs from the app is the imperative API; everything the app
 * needs from it is one element (rendered as a SIBLING of <Excalidraw>, inside div.excalidraw-app) plus the
 * main-menu entry, which reaches `openVoiceSettings()` below rather than a prop drilled through AppMainMenu.
 *
 * Nothing here holds Excalidraw state: the controller owns the state machine, capture.ts owns the microphone, and
 * this file only creates the singletons once the imperative API exists and forwards status to the toolbar. The
 * app's own storage (LocalData / euidosStorage) owns persistence — persist.ts's only job in this app is
 * `sweepGhostPlaceholders`, called on the two LOAD paths (App.tsx initializeScene, Collab.tsx initializeRoom).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { MainMenu } from "@excalidraw/excalidraw";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { assignUtterance } from "./assign";
import { isVoiceEnabled } from "./enabled";
import { createVoiceCapture } from "./capture";
import { createVoiceController } from "./controller";
import { fit } from "./fit";
import { loadSettings, saveSettings, subscribe } from "./settings";
import { SettingsPanel, voiceSettingsIcon } from "./settings-panel";
import { recognizeStroke } from "./stroke";
import { checkHealth, transcribe } from "./stt";
import { mountVoiceToolbarButton } from "./toolbar";

import "./voice.css";

import type { ToolbarHandle, VoiceSettings, VoiceStatus } from "./contracts";
import type { VoiceCapture } from "./contracts-capture";

/**
 * The main menu lives inside <Excalidraw> (excalidraw-app/components/AppMainMenu.tsx) and the panel lives outside
 * it, so "open the settings" crosses the editor boundary. A one-value store rather than a prop threaded through
 * two memoised upstream components: the menu item calls `openVoiceSettings()`, this component subscribes.
 */
let panelOpenState = false;
const panelListeners = new Set<() => void>();
const setPanelOpenState = (next: boolean): void => {
  if (panelOpenState === next) {
    return;
  }
  panelOpenState = next;
  for (const listener of panelListeners) {
    listener();
  }
};
/** Called by the "Voice settings…" main-menu item. */
export const openVoiceSettings = (): void => setPanelOpenState(true);

const subscribePanel = (listener: () => void): (() => void) => {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
};

/** F9 must reach the controller from the canvas; only the settings panel's own fields swallow it. */
function isPanelInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && target.closest(".voice-settings") !== null
  );
}

/**
 * The "Voice settings…" main-menu entry, owned here rather than spelled out in the app's AppMainMenu.tsx: the
 * icon and the panel store both live in this module, so upstream's file costs one import and one element.
 *
 * `MainMenu.Item` is `DropdownMenu.Item`, and MainMenu only introspects its own children for the Trigger and the
 * Content components — items are rendered straight through — so wrapping one in a component is safe.
 */
export const VoiceSettingsMenuItem = () => {
  if (!isVoiceEnabled()) {
    return null;
  }
  return (
    <MainMenu.Item
      icon={voiceSettingsIcon}
      data-testid="menu-voice-settings"
      onSelect={() => openVoiceSettings()}
    >
      Voice settings…
    </MainMenu.Item>
  );
};

/** Kill switch at the boundary, so the component below never has to reason about conditional hooks. */
export const VoiceTool = (props: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) => (isVoiceEnabled() ? <VoiceToolImpl {...props} /> : null);

const VoiceToolImpl = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) => {
  const panelOpen = useSyncExternalStore(
    subscribePanel,
    () => panelOpenState,
    () => false,
  );
  const [settings, setSettings] = useState<VoiceSettings>(() => loadSettings());
  const [level, setLevel] = useState(0);
  /** The VAD's room tone, read alongside the level so the panel's threshold marker matches the VAD's real line. */
  const [noiseFloor, setNoiseFloor] = useState(0);
  const toolbarRef = useRef<ToolbarHandle | null>(null);
  const captureRef = useRef<VoiceCapture | null>(null);
  /** The deviceId the live capture was built for, so a settings write that did not change it re-acquires nothing. */
  const preparedDeviceRef = useRef<string | null>(null);
  /** Read inside capture.onLevel: the meter is a prop of the panel, so a closed panel must not re-render the app. */
  const panelOpenRef = useRef(false);

  // Panel writes go through settings.ts so the controller (which reads loadSettings()) sees them immediately.
  const onSettingsChange = useCallback((next: VoiceSettings) => {
    saveSettings(next);
  }, []);
  const onPanelClose = useCallback(() => setPanelOpenState(false), []);
  useEffect(() => subscribe(setSettings), []);

  useEffect(() => {
    panelOpenRef.current = panelOpen;
    if (!panelOpen) {
      setLevel(0);
    }
  }, [panelOpen]);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const api = excalidrawAPI;
    const current = loadSettings();
    const capture = createVoiceCapture({
      vad: {
        threshold: current.vadThreshold,
        minUtteranceMs: current.minSegmentMs,
      },
    });
    captureRef.current = capture;
    preparedDeviceRef.current = current.deviceId;
    // Assigned BEFORE the controller, which chains rather than replaces the handler it finds: the toolbar reads the
    // level off VoiceStatus, and only the open settings panel needs it as React state.
    capture.onLevel = (rms: number) => {
      if (panelOpenRef.current) {
        // RAW RMS straight through: the display gain belongs to the surface that draws it (voice/level.ts).
        setLevel(rms);
        setNoiseFloor(capture.noiseFloor);
      }
    };

    // Fonts before anything is measured: fit.ts only learns the real text metrics once the webfont has loaded, so a
    // kiosk that boots and is spoken into straight away would otherwise fit its first transcript against the
    // fallback font. Idempotent and cached — the controller awaits the same promise before it arms.
    void fit.warmFonts(api.getAppState().currentItemFontFamily);

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
      // The editor root, not this component's subtree: the button is injected into the library's own toolbar row.
      // The mobile layout never renders one, so this poll simply never resolves there (the mount's own
      // MutationObserver handles the later re-renders).
      const root = document.querySelector<HTMLElement>(
        ".excalidraw-app .excalidraw",
      );
      if (root && root.querySelector(".App-toolbar")) {
        toolbarRef.current = mountVoiceToolbarButton(root, {
          onToggle: () => controller.toggleLatch(),
          onRetry: () => controller.retryFailed(),
        });
        toolbarRef.current.update(controller.getStatus());
        return;
      }
      poll = setTimeout(mountToolbar, 100);
    };
    mountToolbar();

    // Capture phase: the app passes `handleKeyboardGlobally` to <Excalidraw>, so the editor's own window listener
    // would otherwise see F9 first.
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
      setSettings: (patch: Partial<VoiceSettings>) =>
        saveSettings({ ...loadSettings(), ...patch }),
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
      // Identity-guarded: under <StrictMode> the first mount's cleanup runs AFTER the second mount has installed
      // its own debug surface, and deleting it would take the live one away from the e2e.
      if (window.__excalidrawVoice === debug) {
        delete window.__excalidrawVoice;
      }
    };
  }, [excalidrawAPI]);

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

  return (
    <SettingsPanel
      open={panelOpen}
      onClose={onPanelClose}
      settings={settings}
      onChange={onSettingsChange}
      checkHealth={checkHealth}
      level={level}
      noiseFloor={noiseFloor}
    />
  );
};
