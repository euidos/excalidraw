# RETRO — 0.1.0 voice-areas (round 1)

Cycle shape: DESIGN + contracts → 5 parallel module builders → 1 integrator → 1 e2e driver → 4 review lenses.
Outcome: build green, 12/12 e2e green, **all four lenses returned `fail`**. The gates passed and the product did
not. This memo is about why those two facts coexist.

## What earned reuse

- **`src/contracts.ts` as the coordination device.** Five builders on disjoint files, zero cross-edits, `tsc
  --noEmit` clean on the integrator's *first* run, App.tsx the only wiring work (integrator notes). Keep this
  shape: contracts first, disjoint ownership, integrator wires only.
- **`test/unit/stroke.test.ts`** — 11 deterministic cases, sin-based jitter instead of randomness, no flake across
  the cycle. Geometry that can be tested in-process should never be tested through the browser.
- **The real-surface e2e rig**: per-test Chromium launch because `--use-file-for-fake-audio-capture` is a launch
  flag (test/e2e/helpers.ts:4), real STT at 100.81.33.83:8770, `window.__excalidrawVoice` as the assertion surface.
  The rig is sound; the *cases* it runs are the problem (below).
- **Builder risk lists.** They were accurate predictions, not hedging: fit's container-growth floor, controller's
  30 ms + rAF window, StrictMode double-arm, line text outside `boundElements`. Three of the four lens blockers
  are literally paraphrases of risks a builder had already written down.

## What only looked like progress

- **`src/contracts-capture.ts`** (90 lines, committed to `src/` in f344766): zero importers in `src/`, `test/`,
  `scripts/`; declares `capture.ts`/`assign.ts` that do not exist; its header says it replaces the segmenting that
  shipped `audio.ts` still implements. `src/` currently carries two contradicting contracts.
- **`test/fixtures/three-utterances.wav` + `.json`** — built specifically to catch the hate pass's root objection
  (speech-before-stroke misassignment). No test references them. Same for `ko-long.wav`, `en-long.wav`,
  `ko-mixed.wav`.
- **The green gate board itself.** See L1.

## Lessons

**L1 — A gate authored from the builder's report tests the implementation's happy zone, not the product.**
Every soft spot a lens found sits exactly where the e2e chose a friendly parameter:
- fit's builder wrote "a G4 assertion of 'container size unchanged' must use boxes >= ~120x90". G4a
  (voice.spec.ts:172) calls `buildPlaceholder` directly at **240x120** and passes. The stylus lens measured a
  60x40 ellipse growing to **60x280** with one ordinary Korean sentence — the exact case the gate was steered away
  from.
- G1 holds for 12.5 s over a **looping** 11 s WAV ("holding longer than one loop puts the whole sentence in this
  one segment", voice.spec.ts:52) so every segment window is guaranteed to contain speech and a wrong boundary
  cannot show up.
- `drawStroke` always sleeps **120 ms** after `mouse.up` (helpers.ts:204) and G2 sleeps another 600 ms between
  strokes — the controller's capture races live in a ~45 ms window, so no case can reach them.
- Every e2e case runs at **zoom 1** with generous strokes; both of the stylus lens's directions of failure need a
  zoom ≠ 1.
Gate: G-parameters come from the casebook's declared operating envelope, never from a builder report, and each
gate carries at least one case at the hostile end of its range.

**L2 — Failure was designed as an internal field instead of a channel, so degradation is silent everywhere.**
One root, four sightings: `audio.ts` catches every mic exception and only mutates its private `mic` field, which
makes `controller.armBody`'s disarm-on-mic-failure branch (controller.ts:390) **dead code** — a denied mic leaves
the tool armed, hijacking strokes into placeholders that are later discarded with no `lastError`; a stroke landing
in the deferred-capture window stays as raw ink with no placeholder and `completed` unchanged; `fit`'s "library
unavailable" fallbacks `console.warn` and return `undefined` cast as an element; `dispatch`'s handlers run against
a torn-down editor after `dispose()`. In all four the system continues in a wrong state and tells nobody.
Gate: every module boundary that can fail returns a typed result to its caller; no caller learns about failure by
reading the callee's field; each boundary has a test asserting the failure reaches `status.lastError`.

**L3 — Deferred work keyed to a user event needs a flush barrier, not a hope about timing.**
`onPointerUp → setTimeout(30) → rAF → captureStroke` has no barrier: a pointer-down or an F9 release inside the
window skips the capture (correctness lens reproduced both against the shipped bundle at 15 ms), and
`captureStroke`'s `finally { snapshotScene() }` then folds the next stroke's in-progress freedraw into the
"already seen" baseline so it can never be recognised. Related same-family defect: `fresh[0]` identifies "the
element this stroke made" by scene order over a whole-scene diff, so an undo/paste/remote insert while armed
converts the *wrong* element.
Gate: any deferred handler is a named, flushable unit run synchronously at the head of every event that could
invalidate it; identity of "the thing this interaction produced" is taken from the interaction, not from a scene
diff; e2e includes a zero-gap stroke pair and a disarm-immediately-after-pen-up case.

**L4 — Gesture-scale constants in scene pixels are wrong on any surface the user can zoom.**
`recognize(points)` is called with no options (controller.ts:481), so the tap floor is a fixed 12 **scene** px:
measured, at zoom 0.5 a 6-screen-px jitter becomes a real line that claims the open audio segment; at zoom 8 a
deliberate 120-screen-px underline is 15 scene px and near deletion. Same unit confusion in
`verticalLineAreaWidth`, the line-text offset and the placeholder font clamp.
Gate: no constant derived from a human gesture is expressed in scene px; each is divided by
`appState.zoom.value` at the call site, and the e2e runs the recognition cases at zoom 0.4 and zoom 4.

**L5 — Decisions recorded in a REF but not registered as gate rows do not happen.**
The hate pass settled round-2 segmenting and produced the fixture for it; the fixture is unused, the contract sits
unreferenced in `src/`, and nothing in EVIDENCE.local.md tracks either. This is the same failure the founder has
already paid for elsewhere (board decisions never linked into the register). A decision is real when it has a row
with a proof path.
Gate: every decision in a REF or hate pass, and every risk in a builder report, exits the cycle as either a gate
row in EVIDENCE.local.md or an explicit "accepted, not tested" line. The memo step fails if any is unplaced.

**L6 — Reported evidence was not read back from the artifact.**
The driver's final report cites `test-results/last-run.txt` — **the file does not exist** — and reports
`maxPendingSeen: 0` while the G2 spec asserts `>= 2` and passed. `retries: 1` is configured to absorb STT
nondeterminism and duly absorbed G2's first-attempt failure ("expected 3 bound texts, got 2"), which the driver
itself calls "a timing race in the sandbox"; the stale
`test-results/voice-voice-areas-G2-paral-…/trace.zip` is still on disk.
Gate: gate runs use `retries: 0` and a flake is a failure; the run log is written to the cited path and the memo
step verifies every cited evidence path exists before any status is marked met.

**L7 — Contracts typed signatures, so nobody owned the invariants between modules.**
Five modules, all individually defensible, and the three worst defects are ownership gaps: who converts
screen→scene units (controller or stroke?), who is allowed to change a shape the user drew (`fit` silently adopts
the library's grown geometry, contradicting G4's own wording), who reports a dead mic (audio has the fact, only
controller has the surface). No lens found a module wrong; all four found the seams wrong.
Gate: the contract file states, per boundary, the unit, the error channel and the owner of each mutable
quantity; a cross-module invariant without a named owner blocks the build step.

## Anti-patterns (failure mode → catching gate)

| Anti-pattern | Failure mode observed | Gate |
| --- | --- | --- |
| Builder-calibrated gate | G4a asserts no-growth at 240x120 because the builder said <120x90 fails; 60x40 grows 7x | Envelope-declared parameters + one hostile-end case per gate |
| Sleep-padded e2e | 120 ms after every pen-up hides a 45 ms capture race that loses whole strokes | Zero-gap and interrupt cases; no unconditional sleep in helpers |
| Speech that never stops | Looping WAV makes every segment boundary look correct | Per-utterance fixture with silence gaps; assert words per shape |
| Error as a private field | Denied mic leaves the tool armed and recording nothing; disarm branch is dead code | Typed failure results; status.lastError assertion per boundary |
| Scene-px gesture constants | 12 px tap floor swallows a real underline at zoom 8, promotes jitter at zoom 0.5 | Zoom-normalised constants; e2e at zoom 0.4 / 4 |
| Diff-by-scene-order identity | Undo while armed converts the restored old stroke, ink stays ink | Interaction-scoped identity; undo-while-armed e2e case |
| Forward contract in src/ | Two contradicting contracts shipped; 90 lines nothing imports | src/ holds only contracts the shipped modules implement |
| Unregistered decision | Round-2 fixture and contract exist, no test or row references them | Decision/risk → gate row or accepted-risk line, enforced at memo |
| Retry-absorbed flake | G2's real race counted as a pass | retries:0 on gate runs |
| Unverified evidence citation | last-run.txt cited, absent; maxPendingSeen reported 0 vs asserted ≥2 | Memo verifies every cited path before marking met |

## Next-cycle gates (proposed, for the main loop to fold into EVIDENCE)

- **N1 Envelope** — DESIGN declares the operating envelope (zoom 0.4–4, shape 40x30–800x600, inter-stroke gap
  0 ms–5 s, IR multi-touch) and every gate names where in it each case sits.
- **N2 Boundary-race** — zero-gap stroke pair, disarm inside the capture window, undo while armed: each produces
  exactly one shape per stroke and no orphan ink.
- **N3 Visible failure** — mic denied / mic unplugged mid-hold / STT dead: the tool disarms or surfaces
  `lastError`, and never converts a stroke it cannot transcribe.
- **N4 Geometry ownership** — the drawn shape's width/height are byte-identical after commit at 60x40 with a long
  Korean transcript (overflow spills as unbound text, the founder's shape is never resized).
- **N5 Zoom invariance** — the same physical gesture recognises identically at zoom 0.4, 1 and 4.
- **N6 Utterance assignment** — `three-utterances.wav` (silence-gapped, `%noloop`) with three strokes: assert the
  *words* in each shape, not the count.
- **N7 Single contract** — `src/` imports every contract it contains; no unreferenced module in `src/`.
- **N8 Evidence integrity** — `retries: 0`, run log written, every path cited in a report exists.

## Vocabulary for the next agent

- **operating envelope / hostile end** — the declared range of a parameter, and the worst value in it; gates cite
  both.
- **flush barrier** — the synchronous run-now handle on deferred work, invoked by any event that would invalidate it.
- **error channel vs. error field** — a typed value the caller must handle vs. state the caller has to think to read.
- **scene px vs. screen px** — the unit split; gesture thresholds are screen, geometry is scene.
- **interaction-scoped identity** — "the element this pointer interaction made", never "the element that is new".
- **gate row** — a line in EVIDENCE.local.md with a proof path; a decision without one did not happen.
- **utterance** (round 2) vs. **segment** (round 1) — atomic speech bounded by VAD silence vs. audio between
  pointer-downs. Round 2 assigns utterances to strokes; do not mix the words.
- **declared risk** — a builder-reported hazard; exits the cycle as a gate row or an accepted-risk line.
