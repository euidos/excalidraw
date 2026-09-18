/**
 * assign.ts — pure utterance→stroke assignment (contracts-capture.ts `AssignUtterance`).
 *
 * One rule, stated once: a stroke may claim an utterance when the stroke's pointer-down is no later than the
 * utterance's onset plus the pre-roll, and among those the LATEST pointer-down wins. The pre-roll exists because
 * people say the label a moment before they draw the box ("say then draw"); the "latest wins" half is what makes
 * that work — an utterance that starts inside the pre-roll window of the next stroke belongs to the next stroke,
 * not to the one already on the canvas.
 *
 * `final` says when the answer may be acted on: only once no future stroke could still become a candidate, i.e.
 * once the pre-roll window that started at the onset has elapsed. Before that the same utterance may legitimately
 * change owner, so the controller must hold it.
 */
import type { AssignOptions, AssignUtterance, Assignment, StrokeRecord, Utterance } from "./contracts-capture";

const DEFAULT_PRE_ROLL_MS = 1500;

export const assignUtterance: AssignUtterance = (
  u: Utterance,
  strokes: readonly StrokeRecord[],
  nowMs: number,
  opts?: AssignOptions,
): Assignment => {
  const preRollMs = opts?.preRollMs ?? DEFAULT_PRE_ROLL_MS;
  const deadline = u.onsetMs + preRollMs;

  // Single pass, no intermediate arrays: strokes arrive in whatever order the caller kept them, and this runs on
  // every VAD event. `>=` on the tie so the LAST equally-late stroke in the array wins, as the contract states.
  let best: StrokeRecord | undefined;
  for (const stroke of strokes) {
    if (stroke.downMs > deadline) continue;
    if (best === undefined || stroke.downMs >= best.downMs) best = stroke;
  }

  return { strokeId: best ? best.id : null, final: nowMs >= deadline };
};

export default assignUtterance;
