/**
 * Injects the voice tool into Excalidraw's own desktop toolbar by mirroring its markup
 * (label.ToolIcon > div.ToolIcon__icon), so the button inherits the library's sizing and theming.
 * DOM-level rather than React because the toolbar is rendered inside the library's own tree.
 */
import type { MountVoiceToolbarButton, ToolbarHandle, ToolbarOptions, VoiceStatus } from "./contracts";

const LONG_PRESS_MS = 600;

const MIC_SVG = `<svg aria-hidden="true" focusable="false" role="img" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>`;

const RETRY_SVG = `<svg aria-hidden="true" focusable="false" role="img" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;

function findToolbarRow(root: HTMLElement): HTMLElement | null {
  const rows = root.querySelectorAll<HTMLElement>(".App-toolbar .Stack_horizontal");
  for (const row of rows) {
    if (row.querySelector('input[data-testid="toolbar-freedraw"]')) {
      return row;
    }
  }
  return null;
}

/** The last native tool button — our buttons go after it but before the divider + extra-tools trigger. */
function lastNativeToolLabel(row: HTMLElement): HTMLElement | null {
  const labels = row.querySelectorAll<HTMLElement>("label.ToolIcon");
  let last: HTMLElement | null = null;
  for (const label of labels) {
    if (label.classList.contains("voice-tool") || label.classList.contains("voice-retry")) {
      continue;
    }
    if (label.querySelector('input[data-testid^="toolbar-"]')) {
      last = label;
    }
  }
  return last;
}

export const mountVoiceToolbarButton: MountVoiceToolbarButton = (
  excalidrawRoot: HTMLElement,
  opts: ToolbarOptions,
): ToolbarHandle => {
  const button = document.createElement("label");
  button.className = "ToolIcon Shape voice-tool";
  button.title = "Voice area — hold F9 or tap to latch";
  button.setAttribute("data-testid", "toolbar-voice");
  button.setAttribute("role", "button");
  button.setAttribute("aria-label", "Voice area");
  button.setAttribute("aria-pressed", "false");
  button.innerHTML =
    `<div class="ToolIcon__icon">${MIC_SVG}<span class="ToolIcon__keybinding">F9</span>` +
    `<span class="voice-tool__badge"></span><span class="voice-tool__dot"></span></div>`;
  const badge = button.querySelector<HTMLElement>(".voice-tool__badge")!;

  const retry = document.createElement("label");
  retry.className = "ToolIcon voice-retry";
  retry.title = "Retry failed transcriptions";
  retry.setAttribute("data-testid", "toolbar-voice-retry");
  retry.setAttribute("role", "button");
  retry.setAttribute("aria-label", "Retry failed transcriptions");
  retry.hidden = true;
  retry.innerHTML = `<div class="ToolIcon__icon">${RETRY_SVG}</div>`;

  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressFired = false;

  const clearLongPress = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault(); // keep focus on the canvas and stop touch scroll/selection
    longPressFired = false;
    clearLongPress();
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      opts.onOpenSettings();
    }, LONG_PRESS_MS);
  };
  const onPointerUp = (e: PointerEvent) => {
    e.preventDefault();
    clearLongPress();
    if (!longPressFired) {
      opts.onToggle();
    }
  };
  const onPointerCancel = () => {
    clearLongPress();
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    clearLongPress();
    longPressFired = true;
    opts.onOpenSettings();
  };

  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("pointerup", onPointerUp);
  button.addEventListener("pointercancel", onPointerCancel);
  button.addEventListener("pointerleave", onPointerCancel);
  button.addEventListener("contextmenu", onContextMenu);

  const onRetryDown = (e: PointerEvent) => e.preventDefault();
  const onRetryUp = (e: PointerEvent) => {
    e.preventDefault();
    opts.onRetry();
  };
  retry.addEventListener("pointerdown", onRetryDown);
  retry.addEventListener("pointerup", onRetryUp);

  const inject = () => {
    if (button.isConnected && retry.isConnected) {
      return;
    }
    const row = findToolbarRow(excalidrawRoot);
    if (!row) {
      return; // mobile layout or not rendered yet; the observer retries
    }
    const anchor = lastNativeToolLabel(row);
    if (anchor) {
      anchor.after(button);
    } else {
      row.appendChild(button);
    }
    button.after(retry);
  };

  let frame: number | null = null;
  const observer = new MutationObserver(() => {
    if (button.isConnected && retry.isConnected) {
      return;
    }
    if (frame !== null) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = null;
      try {
        inject();
      } catch (err) {
        console.warn("[voice] toolbar injection failed", err);
      }
    });
  });

  try {
    inject();
  } catch (err) {
    console.warn("[voice] toolbar injection failed", err);
  }
  observer.observe(excalidrawRoot, { childList: true, subtree: true });

  return {
    update(status: VoiceStatus) {
      button.classList.toggle("voice-tool--armed", status.mode !== "idle");
      button.classList.toggle("voice-tool--recording", status.recording);
      button.classList.toggle(
        "voice-tool--mic-missing",
        status.mic === "denied" || status.mic === "missing" || status.mic === "error",
      );
      button.setAttribute("aria-pressed", status.mode !== "idle" ? "true" : "false");
      const label = status.pending > 0 ? String(status.pending) : "";
      if (badge.textContent !== label) {
        badge.textContent = label;
      }
      retry.hidden = status.failed <= 0;
    },
    unmount() {
      observer.disconnect();
      clearLongPress();
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      button.removeEventListener("pointerdown", onPointerDown);
      button.removeEventListener("pointerup", onPointerUp);
      button.removeEventListener("pointercancel", onPointerCancel);
      button.removeEventListener("pointerleave", onPointerCancel);
      button.removeEventListener("contextmenu", onContextMenu);
      retry.removeEventListener("pointerdown", onRetryDown);
      retry.removeEventListener("pointerup", onRetryUp);
      button.remove();
      retry.remove();
    },
  };
};
