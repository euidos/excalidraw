/**
 * Injects the voice tool into Excalidraw's own desktop toolbar by mirroring its markup
 * (label.ToolIcon > div.ToolIcon__icon), so the button inherits the library's sizing and theming.
 * DOM-level rather than React because the toolbar is rendered inside the library's own tree.
 *
 * Round 2 (R6): a tap of ANY duration toggles the latch. The long-press / contextmenu path to settings is gone —
 * on the IR frame a "tap" is routinely 700 ms+, so long-press stole the founder's latch taps and opened settings
 * instead. Settings now live behind App's top-right gear; `opts.onOpenSettings` stays in the contract but no
 * gesture on this button is wired to it.
 */
import type { MountVoiceToolbarButton, ToolbarHandle, ToolbarOptions, VoiceStatus } from "./contracts";
import { meterPercent } from "./level";

/** A press that travels further than this (CSS px) is a drag/palm smear, not a tap. */
const TAP_SLOP_PX = 24;

const MIC_SVG = `<svg aria-hidden="true" focusable="false" role="img" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>`;

const RETRY_SVG = `<svg aria-hidden="true" focusable="false" role="img" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;

const BASE_TITLE = "Voice area — hold F9 or tap to latch";

/**
 * The button's tooltip, as a pure function of the status — the wall panel has no console, so this string is the
 * only place a failure or a silently filtered transcript can be read back. Round 2 counted `dropped` and rendered
 * it nowhere (RETRO L2 / gate N10); exported so that rendering is gated without a DOM.
 */
export function buttonTitle(status: VoiceStatus): string {
  const error = status.lastError ? `\n⚠ ${status.lastError}` : "";
  const dropped =
    status.dropped > 0
      ? `\ndropped ${status.dropped}${status.lastDropped ? `: "${status.lastDropped}"` : ""}`
      : "";
  return `${BASE_TITLE}${error}${dropped}`;
}

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
  button.title = BASE_TITLE;
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

  /** Pointer that currently owns the press, and where it went down (for the slop check). */
  let pressId: number | null = null;
  let pressX = 0;
  let pressY = 0;

  const endPress = () => {
    pressId = null;
    button.classList.remove("voice-tool--pressed");
  };

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault(); // keep focus on the canvas and stop touch scroll/selection
    pressId = e.pointerId;
    pressX = e.clientX;
    pressY = e.clientY;
    // The IR frame reports no hover, so the press class is the only feedback that the tap registered at all.
    button.classList.add("voice-tool--pressed");
  };
  const onPointerUp = (e: PointerEvent) => {
    e.preventDefault();
    if (pressId !== e.pointerId) {
      return;
    }
    const moved = Math.hypot(e.clientX - pressX, e.clientY - pressY);
    endPress();
    if (moved <= TAP_SLOP_PX) {
      opts.onToggle();
    }
  };
  const onPointerCancel = (e: PointerEvent) => {
    if (pressId === null || pressId === e.pointerId) {
      endPress();
    }
  };

  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("pointerup", onPointerUp);
  button.addEventListener("pointercancel", onPointerCancel);
  button.addEventListener("pointerleave", onPointerCancel);

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
      // status.level is RAW RMS (gate N12); the display gain is this surface's own, through the shared mapping.
      const level = (meterPercent(status.level) / 100).toFixed(2);
      if (button.style.getPropertyValue("--voice-level") !== level) {
        button.style.setProperty("--voice-level", level);
      }
      const title = buttonTitle(status);
      if (button.title !== title) {
        button.title = title;
      }
      retry.hidden = status.failed <= 0;
      const retryTitle =
        status.failed > 0
          ? `Retry ${status.failed} failed transcription${status.failed === 1 ? "" : "s"}`
          : "Retry failed transcriptions";
      if (retry.title !== retryTitle) {
        retry.title = retryTitle;
      }
    },
    unmount() {
      observer.disconnect();
      endPress();
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      button.removeEventListener("pointerdown", onPointerDown);
      button.removeEventListener("pointerup", onPointerUp);
      button.removeEventListener("pointercancel", onPointerCancel);
      button.removeEventListener("pointerleave", onPointerCancel);
      retry.removeEventListener("pointerdown", onRetryDown);
      retry.removeEventListener("pointerup", onRetryUp);
      button.remove();
      retry.remove();
    },
  };
};
