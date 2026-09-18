/**
 * Injects the voice tool into Excalidraw's own desktop toolbar by mirroring its markup
 * (button.ToolIcon.ToolIcon_type_toggle > div.ToolIcon__icon), so the button inherits the library's sizing
 * and theming. DOM-level rather than React because the toolbar is rendered inside the library's own tree.
 *
 * Phase 2 (port to the monorepo): 0.18.1 rendered a tool as `label.ToolIcon` wrapping a hidden
 * `input[data-testid="toolbar-<type>"]`; master's `IconButton` renders a single
 * `button.ToolIcon.ToolIcon_type_toggle.ToolIcon_size_medium[data-testid="toolbar-<type>"]` and the old
 * `Shape` class is gone (`fillable` now). Every selector and the injected element follow that — the mirrored
 * markup IS the contract with the library here, and it is the one thing a unit test cannot hold.
 *
 * Round 2 (R6): a tap of ANY duration toggles the latch. The long-press / contextmenu path to settings is gone —
 * on the IR frame a "tap" is routinely 700 ms+, so long-press stole the founder's latch taps and opened settings
 * instead. Settings live in Excalidraw's own top-left main menu (round 4b, App.tsx), so this button has no
 * settings gesture and `ToolbarOptions` no longer carries a hook for one (round 4c).
 *
 * Round 4b: the glyph itself is the level meter — see MIC_SVG and buttonVisualState.
 */
import type { MountVoiceToolbarButton, ToolbarHandle, ToolbarOptions, VoiceStatus } from "./contracts";
import { glyphLevel } from "./level";

/** A press that travels further than this (CSS px) is a drag/palm smear, not a tap. */
const TAP_SLOP_PX = 24;

/** The mic capsule, as one path — drawn twice: once as the outline, once filled and clipped to the level. */
const MIC_CAPSULE_PATH = "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z";
/** The capsule's own vertical extent in viewBox units; the clip rect covers exactly this, so level 0.5 = half a capsule. */
const CAPSULE_TOP = 2;
const CAPSULE_HEIGHT = 13;
/**
 * The clipPath id. Document-global (SVG references are by id), and there is exactly one voice button per app, so a
 * plain constant is honest; a second instance would need a counter.
 */
const MIC_CLIP_ID = "voice-mic-level-clip";

/**
 * The mic glyph. The filled capsule under the outline is the level display: `.voice-mic__fill` is clipped by a rect
 * that voice.css scales from its bottom edge by `--voice-level`, so the capsule fills like a tube and the founder can
 * see from 2–3 m that the microphone is hearing the room (round 4b, founder request 2). The outline never moves, so
 * the button is still recognisable at level 0.
 */
const MIC_SVG =
  `<svg aria-hidden="true" focusable="false" role="img" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<defs><clipPath id="${MIC_CLIP_ID}"><rect class="voice-mic__clip" x="8" y="${CAPSULE_TOP}" width="8" height="${CAPSULE_HEIGHT}"/></clipPath></defs>` +
  `<path class="voice-mic__fill" d="${MIC_CAPSULE_PATH}" fill="currentColor" stroke="none" clip-path="url(#${MIC_CLIP_ID})"/>` +
  `<path d="${MIC_CAPSULE_PATH}"/>` +
  `<path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>`;

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

/** Every class this button toggles, and the value of --voice-level, as a pure function of the status. */
export interface ToolbarVisualState {
  /** class name → present. Written with classList.toggle, so an absent key is never removed accidentally. */
  classes: {
    "voice-tool--armed": boolean;
    "voice-tool--recording": boolean;
    "voice-tool--speaking": boolean;
    "voice-tool--mic-missing": boolean;
  };
  /** `--voice-level`: 0..1, the DISPLAY value (status.level is RAW RMS — gate N12, one unit, one mapping). */
  level: number;
}

/**
 * Status → what the button looks like. Pure, so the mapping is gated without a DOM (the button itself is proven in
 * the e2e). Idle forces level 0 and speaking false: `status.level` keeps the last RMS after a disarm, and a static
 * outline is the whole point of "armed vs idle is obvious at a glance".
 */
export function buttonVisualState(status: VoiceStatus): ToolbarVisualState {
  const armed = status.mode !== "idle";
  return {
    classes: {
      "voice-tool--armed": armed,
      "voice-tool--recording": status.recording,
      "voice-tool--speaking": armed && status.speaking,
      "voice-tool--mic-missing":
        status.mic === "denied" || status.mic === "missing" || status.mic === "error",
    },
    // The glyph's own display curve (level.ts `glyphLevel`): the settings meter keeps the VAD-threshold axis, whose
    // 0.06 full scale pinned the capsule at 100% for anything louder than a whisper.
    level: armed ? glyphLevel(status.level) : 0,
  };
}

function findToolbarRow(root: HTMLElement): HTMLElement | null {
  const rows = root.querySelectorAll<HTMLElement>(".App-toolbar .Stack_horizontal");
  for (const row of rows) {
    if (row.querySelector('[data-testid="toolbar-freedraw"]')) {
      return row;
    }
  }
  return null;
}

/** The last native tool button — our buttons go after it but before the divider + extra-tools trigger. */
function lastNativeToolLabel(row: HTMLElement): HTMLElement | null {
  const labels = row.querySelectorAll<HTMLElement>("button.ToolIcon");
  let last: HTMLElement | null = null;
  for (const label of labels) {
    if (label.classList.contains("voice-tool") || label.classList.contains("voice-retry")) {
      continue;
    }
    // master puts the testid on the button itself, not on a nested input.
    if (label.matches('[data-testid^="toolbar-"]')) {
      last = label;
    }
  }
  return last;
}

export const mountVoiceToolbarButton: MountVoiceToolbarButton = (
  excalidrawRoot: HTMLElement,
  opts: ToolbarOptions,
): ToolbarHandle => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ToolIcon ToolIcon_type_toggle ToolIcon_size_medium voice-tool";
  button.title = BASE_TITLE;
  button.setAttribute("data-testid", "toolbar-voice");
  button.setAttribute("aria-label", "Voice area");
  button.setAttribute("aria-pressed", "false");
  button.innerHTML =
    // The ring is first so it paints BEHIND the glyph: it grows with --voice-level and must never obscure the mic.
    `<div class="ToolIcon__icon"><span class="voice-tool__ring"></span>${MIC_SVG}` +
    `<span class="ToolIcon__keybinding">F9</span>` +
    `<span class="voice-tool__badge"></span><span class="voice-tool__dot"></span></div>`;
  const badge = button.querySelector<HTMLElement>(".voice-tool__badge")!;

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ToolIcon ToolIcon_type_toggle ToolIcon_size_medium voice-retry";
  retry.title = "Retry failed transcriptions";
  retry.setAttribute("data-testid", "toolbar-voice-retry");
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
      const visual = buttonVisualState(status);
      for (const [name, on] of Object.entries(visual.classes)) {
        button.classList.toggle(name, on);
      }
      button.setAttribute("aria-pressed", status.mode !== "idle" ? "true" : "false");
      const label = status.pending > 0 ? String(status.pending) : "";
      if (badge.textContent !== label) {
        badge.textContent = label;
      }
      // The display mapping lives in buttonVisualState → level.ts (gate N12): the glyph, the ring and the settings
      // meter are all the same function of the same raw RMS.
      const level = visual.level.toFixed(2);
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
