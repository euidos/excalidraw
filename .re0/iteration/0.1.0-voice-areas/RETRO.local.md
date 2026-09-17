# RETRO — 0.1.0 voice-areas (current, after round 3)

One document, rewritten each round. Lessons that still bite stay below in their current form; the ones a later
gate actually closed are in **Closed** at the end with the gate that closed them.

Round-2 cycle shape: DESIGN R1–R7 + `src/contracts-capture.ts` made live → 5 builders (capture/vad, assign, fit,
ui-persist-settings, controller) → integrator (App.tsx, `audio.ts` deleted) → e2e driver (**22/22**, retries 0,
real STT) → 2 review lenses (**both `fail`, 2 blockers**) → post-review fix (**23/23**, unit 88/88) → cold read
(`minor-gaps`).

Outcome to hold on to: **the board went green, a lens drove the same shipped bundle by hand and found a blocker,
the board went green again.** Round 1 ended the same way with four lenses. That repetition — not any single bug —
is the finding of this round.

Round-3 cycle shape (small round, one fixer): six items drained straight off round 2's **open-rows table** — N12
one scale, N10 rendered drop, N11 recovery, the amara.org blocklist gap, dead `FailedEntry` pruning, the STT
upload filename — then a re-drive. Result: unit **88 → 109**, e2e **23/23** (retries 0, real STT, `/health`
answered `{ok:true, model:large-v3-turbo, warm:true}` before the run), `npm run build` clean. No new defect class
was discovered; every item was already written down. That is the finding of round 3 (L9).

## What earned reuse

- **Contracts-first, disjoint ownership, integrator wires only.** Second round running: five builders, zero
  cross-edits, `tsc --noEmit` clean on the integrator's first run, App.tsx the only wiring. Unchanged verdict.
- **The pure-module split (`vad.ts`, `assign.ts`, `stroke.ts`).** All three are DOM-free and timer-free, so their
  rules are pinned in-process: 15 VAD cases, 26 assignment cases, 11 geometry cases, no flake, no browser. Every
  rule that can be stated without a browser must live in a module shaped like these.
- **The property test over a pure rule.** The post-review fix pinned `isSuperseded` by asserting it agrees with
  `assignUtterance` across a 60-combination grid rather than re-stating the rule. That is the only gate in two
  rounds that would have caught its own blocker before a lens did. Copy the shape, not the case.
- **The e2e rig's move from wall-clock guessing to event subscription.** `recordUtterances` / `waitForUtterance`
  chain onto the real VAD callbacks, so cases schedule against real utterance boundaries. Round 1's "sleep 600 ms
  between strokes" was a timing detail; round 2 showed it decides *who gets the words*. Keep the subscription
  helpers; never reintroduce an unconditional sleep.
- **Builder risk lists, again.** The level-scale mismatch, the dead-target dispatch, the multi-touch stroke loss
  and the unproven capture path were all written down by their builders before any lens ran. Round 1 said the same
  thing. A risk list is a defect list that has not been triaged yet — see L5.

## What only looked like progress

- **22/22 green.** Both lens blockers were invisible to it by construction: `resolveTargets`'s inverted predicate
  only fires when an unassigned utterance is open at the tick, and no timed gate ever arranged that (`[].every()`
  is vacuously true, giving the same answer either way); the capture brick needs a mic to fail and then recover,
  and no case ever recovers a failed mic.
- **`VoiceStatus.dropped` / `lastDropped`.** Added in round 2 so a filtered transcript is not silent; nothing
  rendered them, so on the wall panel a filtered transcript and a silent room looked identical. A channel with no
  rendered sink is a private field with extra steps. *(Closed by N10 in round 3 — see Closed.)*
- **Test parameters chosen to make a gate writable.** N2a pins `preRollMs: 0`; G4d and G5c swapped fixtures
  because the VAD seeds its floor from the first 200 ms; every test forces `warmMicOnBoot: false`. Each is a place
  the harness bent around the product, and one of them hides a live defect (L4).

## Lessons

**L1 — A green suite proves the nominal path; a predicate that destroys user work needs its truth table pinned,
not its happy case.**
Round 1's form of this was "gates calibrated by builder reports". Round 2 fixed that honestly — the envelope is
declared, G4a runs the hostile 120x80, N5 runs zoom 0.5 and 2 — and the class survived anyway, because *every*
e2e case still walks the sequence in which the product works. Evidence: `resolveTargets`'s supersede test read
`later.downMs - preRollMs > onset`, the exact negation of assign.ts's candidate rule, so a shape was discarded
precisely when speech could still claim it; reproduced on the shipped bundle (shape A drawn at ~5 s, ko-long opens
at 7.68 s, shape B at ~8.2 s → A goes solid, the sentence is dispatched into a deleted target, `completed=2` for 3
utterances, no error, no orphan). Same family: `dispatch()` handed utterances to undone shapes; `prepare()`'s fast
path returned a cached `mic`.
Gate (N9): every predicate whose false branch deletes, discards, refuses or restores is extracted as a pure
exported function and gated either by its full truth table or by a property test asserting agreement with the
module that owns the rule. A predicate that exists only inside an async handler is not gated.

**L3 — Deferred work keyed to a user event needs a barrier, and the barrier must cover every consumer of the
deferred fact, not just the producer.**
Round 2 fixed the round-1 form: interaction-scoped identity from `appState.newElement`, the conversion queue,
`Session.conversions` blocking assignment while a stroke is converting — N2a/N2b/N2c all green. The same family
then reappeared in the consumer nobody barriered: a stroke enters `session.strokes` only inside the pointer-**up**
conversion (controller.ts:727), so an utterance whose pre-roll deadline expires while the pen is still down is
finalised against a stroke list that is missing the stroke being drawn for it. Measured on the real surface:
onset 639 ms, deadline 2139 ms, pointer-down 1059 ms, pointer-up 3025 ms → `orphans: 1`, "회의 안건 정리" placed as
free text instead of in the container. **Still open.** Any careful stroke over a label spoken just before it hits
this.
Gate (N2e): with default `preRollMs`, arm, wait past an utterance's onset, then draw a stroke slower than the
pre-roll window → `orphans === 0` and the words land in that stroke's container.

**L4 — A gate that needs a non-default setting to pass has found a defect, not a parameter.**
Round 1's L5 said an unregistered decision did not happen; the round-2 form is sharper because the harness now
writes settings. N2a pins `preRollMs: 0` — at the default the assignment rule gives both sentences to the second
stroke, and the only way to give the first stroke a sentence is a stroke that spans the deadline, i.e. exactly the
open defect above. G4d and G5c changed fixture because the VAD seeds its noise floor from whatever the first 10
frames contain, so a clip with 100 ms of lead-in is transcribed from its second clause. `warmMicOnBoot: false` is
forced everywhere, which means the whole suite exercises a cold mic the kiosk never has.
Gate: each non-default setting or fixture swap in the e2e exits the round as either a defect row or an
"accepted, not tested" row in EVIDENCE.local.md, naming the product behaviour it dodges.

**L5 — A declared risk is an untriaged defect; a decision without a gate row did not happen.**
Both halves recurred verbatim. The lens blockers are paraphrases of builder risks ("the controller must drop
records for deleted shapes", "nothing of the capture path has been exercised against a real microphone"). The
post-review fix's own closing note says N2d and four new unit gates have no EVIDENCE row. Round 1 recorded this
lesson and round 2 reproduced it, which means the memo step, not the builders, is where it must be enforced.
Gate: the memo step fails if any builder risk, lens finding or fixed defect from the round lacks a row — met,
unmet, untested or accepted. (Enforced this round: the rows are written below in EVIDENCE.local.md.)

**L6 — Contracts type shapes, not units, scales or lifetimes — so every seam is still unowned.** *(scale half
closed by N12 in round 3; lifetime half still open.)*
Round 1: who converts screen→scene, who may resize the user's shape, who reports a dead mic. Round 2 answered all
three and opened new ones in the same class. Round 3 closed the scale one — `capture.onLevel` and
`capture.noiseFloor` are raw RMS, `src/level.ts` is the single display mapping the panel and the toolbar both draw
through — and closed one lifetime one, `pruneFailed()` naming the deleter for the `FailedEntry` map. What remains
is the same class untouched: `utteranceSession` is written and never deleted, so every Session a kiosk ever opened
is retained for the life of the page; `fit.discard`/`markFailed` restore the drawn geometry unconditionally, with
no way to tell "grown by our placeholder" from "resized by the user".
Gate: every map keyed by a transient id declares who deletes the entry, and a unit case proves the entry is gone
after its key dies. (`test/unit/controller.test.ts` "a failed entry whose shape has left the scene is pruned" is
the shape to copy.)

**L8 — A capture path proven by construction is not proven.**
Every capture claim entering integration was offline arithmetic plus a Chromium fake device: worklet path,
ScriptProcessor fallback, resume-after-gesture, clock-offset drift, WAV cut accuracy. Two of the round's blockers
and the VAD floor-seeding artefact all live there. The fake mic starts its file at `getUserMedia`, which is why
the suite had to force a cold mic and why the field's warm-mic behaviour has never run under test.
Gate: any audio-graph behaviour asserted this round is re-measured on the kiosk with a real microphone
(`scripts/kiosk-mic-check.mjs` + a cold-start suspend probe) before its row moves off "untested".

**L9 — "Accepted, not tested" is a deferral with no expiry, and round N's accepted row is round N+1's one-line
fix.**
Round 3 added zero new discoveries: all six items were already rows in EVIDENCE.local.md, four of them under
*accepted* or *untested* rather than *unmet*. The costs were trivial once someone picked them up — the
"Subtitles by amara.org" row, pinned in round 2 as a KNOWN GAP test with the note "fix is one
`HALLUCINATION_BLOCKLIST` entry", was exactly that, and the level-scale row that had sat "owner unassigned" cost
one new 100-line module. Meanwhile the label "accepted" was doing real damage: it reads like a decision, so a
round planning itself off the table skips those rows and reaches for the *unmet* ones. L5 said every risk exits
as a row; round 3 shows a row is not enough, because the word in the status column decides whether anyone ever
reads it again.
Gate (N14): a row may only say "accepted" with a named owner and the round number by which it is re-decided; a
row whose fix is estimated at one contract line or one blocklist entry may not say "accepted" at all — it is
*unmet*. Every round's planning step reads the open-rows table before the gate list.

## Anti-patterns (failure mode → catching gate)

| Anti-pattern | Failure mode observed this round | Gate |
| --- | --- | --- |
| Nominal-path-only suite | Inverted supersede predicate green in 22/22; lens found it by hand in one session | N9 truth-table / property gate on destructive predicates |
| Predicate buried in an async handler | `resolveTargets`'s comparison had no callable form until the fix extracted `isSuperseded` | Destructive rules are exported pure functions |
| Channel without a sink | `dropped`/`lastDropped` in VoiceStatus, nothing renders them | N10 — **closed round 3**: toast at the drop + `dropped N` in the tooltip |
| Barriered producer, unbarriered consumer | Stroke registered at pointer-up; assignment finalises mid-stroke → orphan | N2e slow-stroke-across-deadline case |
| Harness setting as a product parameter | N2a passes only at `preRollMs: 0`, which is the defect | Non-default setting → defect or accepted-risk row |
| Latching failure state | `prepare()` returned cached "error" forever; 500 ms resume verdict never re-checked | N11 — **closed round 3**: enter, clear, re-arm, no reload, no re-acquire |
| Untriaged builder risk | Two lens blockers were already in builder risk lists | Every risk exits as a row |
| "Accepted" as a status | Four round-3 items sat under *accepted*/*untested*; each was a one-item fix | N14 — accepted needs an owner + a re-decide round; one-line fixes are *unmet* |
| Unit without a scale | onLevel RMS×4 drawn against a raw-RMS threshold marker | N12 — **closed round 3**: raw RMS at the seam, `level.ts` the one display mapping |
| Map that is never deleted from | `utteranceSession` retains every Session for the page's life (`failed` closed by `pruneFailed()`) | Every transient-keyed map names its deleter **and proves the entry is gone** |
| Proof by construction | Whole capture path shipped on offline maths + a fake device | Kiosk re-measure before "met" |

## Next-cycle gates

- **N9 Destructive predicate** — every discard/delete/refuse/restore rule is a pure exported function with a truth
  table or property gate against the module that owns the rule.
- **N2e Pre-roll across a live stroke** — default `preRollMs`, speech then a stroke slower than the window →
  `orphans === 0`, words in that stroke's container. (Currently failing; see L3.)
- **N13 Kiosk re-measure** — real-mic cold start, suspend recovery, WAV cut accuracy on the panel. **Still open
  and now the only thing standing between the audio graph and "proven": round 3 removed a display gain from the
  capture path and re-measured nothing on the panel.**
- **N14 Accepted-row hygiene** — an "accepted" row carries an owner and the round it is re-decided in; a one-line
  fix may not be accepted; planning reads the open-rows table first (L9).
- Carried forward unchanged: **N8 evidence integrity** (retries 0, log at the cited path, every path verified).

## Vocabulary for the next agent

Carried from round 1 and still load-bearing: **operating envelope / hostile end**, **flush barrier**, **error
channel vs. error field**, **scene px vs. screen px**, **interaction-scoped identity**, **gate row**,
**declared risk**, **utterance** (VAD-bounded speech; round 1's **segment** is dead — `audio.ts` is deleted).

New this round:

- **nominal path** — the sequence in which the product works. A green suite is evidence about it and nothing else.
- **destructive predicate** — a boolean whose false branch removes user work. Must be pure, exported, gated.
- **rendered sink** — the surface that shows a status field. Without one, the field is not a channel.
- **harness-bent parameter** — a non-default setting or swapped fixture a gate needs in order to pass. Always a
  finding.
- **latching state** — a module state that survives the condition that caused it. Needs a recovery gate.
- **proof by construction** — offline arithmetic or a fake device standing in for the real surface. Not proof.
- **scale (vs. unit)** — the multiplier on a number crossing a boundary. `contracts-capture.ts` now states both
  for the level seam; nothing else does.

New in round 3:

- **open-rows table** — the *Open rows* section of EVIDENCE.local.md. It is the backlog, not an appendix: round 3
  built nothing that was not already a row in it.
- **accepted row** — a risk parked without a test. Only legitimate with an owner and a re-decide round (N14);
  otherwise it is an *unmet* row wearing a decision's clothes (L9).

## Closed (a later gate retired these)

### Retired by round 3

- **L2/round-2 — a failure channel is not done until something renders it.** Closed by **N10**: a drop now renders
  at the moment it happens. `controller.ts` calls `api.setToast({message, duration: 2500})` with
  `Filtered: "<text>"` for a blocklist hit and `No speech heard for that shape` for a non-orphan target that ends
  with no text, and `buttonTitle(status)` puts `dropped N: "<last>"` in the mic button's tooltip.
  Proof: `test/unit/controller.test.ts` → "a dropped transcript is rendered, not only counted (gate N10)" ("toasts
  the filtered text so a blocklist hit cannot be mistaken for a silent room", "toasts a shape that ends with no
  text at all", both asserting `duration === 2500`); `test/unit/toolbar.test.ts` → "buttonTitle — the toolbar says
  how many transcripts were thrown away" (3 cases, incl. the failure line staying readable alongside it); real
  surface `test/e2e/voice.spec.ts:462` G5b asserts `.Toast .Toast__message` reads "No speech heard for that shape"
  (`test-results/last-run.txt:12`, test 9).
  Residue: no e2e drives `status.dropped > 0` — the silence fixture never returns a transcript, so only a real
  hallucination could raise it. The tooltip half is gated by the pure `buttonTitle`, which is the N9 shape.

- **L7/round-2 — a module state that blocks the product needs a recovery gate, not only an entry gate.** Closed by
  **N11**: every blocking capture state is now entered, cleared and re-armed in-process, with no reload and — the
  part that matters on a wall panel — no re-acquisition of the stream.
  Proof: `test/unit/capture.test.ts` → "N11(a) — an audio context that stays suspended past the window and then
  comes back" ("goes error, then ok, and arms again without a reload", asserting `rig.calls === 1`), "N11(b) — a
  muted track" ("errors on mute, clears on unmute, and starts again"), plus the two `prepare()` cases renamed
  N11(c). Every case names its gate in its own title, so the gate is greppable from the suite.

- **N12 scale agreement** (the scale half of L6). Closed: `LEVEL_GAIN` is deleted, `capture.onLevel` and
  `capture.noiseFloor` emit raw RMS with unit and scale stated in `src/contracts-capture.ts` (0..1, speech
  ~0.02–0.2), and `src/level.ts` owns the single display mapping (`meterPercent`, `effectiveThreshold`,
  `meterScale`) that both `settings-panel.tsx` (bar + marker) and `toolbar.tsx` (`--voice-level`) draw through.
  Proof: `test/unit/level.test.ts` → "meterScale — bar and marker are the same function of the same unit" (5
  cases: bar == mark when the room sits on the line; bar/marker ordering matches the VAD's own decision; the
  marker sits at the threshold the VAD really uses, not the setting alone; a property case agreeing with a live
  `createVad` across 5 room floors; clamping) and `test/unit/capture.test.ts` → "N12 — the number the meter is
  drawn from" (2 cases). Before/after reproduced: re-inserting the ×4 fails the two capture cases (0.4 vs 0.1).

### Retired by round 2 (round-1 lessons)

- **L4/round-1 — scene-px gesture constants.** Closed by **N5**: recognition thresholds are divided by
  `appState.zoom.value` at the controller's call site; a 300x160 screen-px oval yields 600x320 scene px at zoom
  0.5 and 150x80 at zoom 2, and a 6-screen-px tap creates nothing at either zoom.
  Proof: `test-results/evidence/n5-zoom-0.5.png`, `n5-zoom-2.png`, `n5-zoom.png`.
- **L6/round-1 — unverified evidence citations.** Closed by **N8**: `playwright.config.ts` has `retries: 0` and
  `outputDir: test-results/artifacts` so Playwright's start-of-run wipe no longer deletes the cited log;
  `test-results/last-run.txt` exists and ends `23 passed (2.7m)`; all 26 cited evidence paths verified present on
  disk at memo time.
- **Round-1 "forward contract in src/" (N7).** Closed: `src/audio.ts` deleted, the retired
  `SegmentRecorder`/`RecorderOptions`/`CreateSegmentRecorder` block removed from `contracts.ts`,
  `src/contracts-capture.ts` now imported by live modules. `src/` holds one contract set.
- **Round-1 "speech that never stops" / looping WAV.** Closed by **N6**: `three-utterances.wav%noloop` played
  once, words asserted per shape and asserted absent from the neighbours, `orphans === 0`.
- **Round-1 N4 geometry ownership** was never adopted as its own row; **G4** absorbed it and now proves
  no container growth at the hostile 120x80 as well as 240x120. G4's documented exception (a shape too small for
  the floor font size is grown visibly) stands.
