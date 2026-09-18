# RETRO — 0.1.0 voice-areas (current, after round 4)

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

Round-4 cycle shape (four founder requests, two builders in parallel, two adversarial lenses, one fixer, one cold
run): builder A took request 1 (shapes are region selection, not drawings) and builder B took requests 2–4 (mic
glyph, main-menu settings, ko/en languages) against the SAME `src/contracts.ts`, disjoint files, no cross-edits —
both reported green (23/23 → 24/23, unit 109 → 138). Two lenses then drove the shipped bundle by hand: a
"correctness of the region lifecycle" lens running a **hate stance** (state the load-bearing objection first, do
not soften it) found two MUST defects builder A's own green suite could not see because both are destructive
paths the nominal sequence never exercises; a **wall-panel founder** persona lens (65", 1–3 m, stylus only, no
keyboard) rendering the ACTUAL settings panel at 4×DPI found a MUST rendering defect (every `var(--color-*)` in
the panel's CSS resolves to nothing outside `.excalidraw`) that no assertion-based test had a way to catch, because
nothing had asked what the panel's computed paint actually was. One fixer applied 12 of 15 findings (3 explicitly
skipped with a written reason each — see L13), re-drove to unit **150/150** (12 files), e2e **24/24**, `npm run
build` clean, and updated CLAUDE.md/README.md/the casebook itself as part of the same commit. A same-day cold run
(no files touched) reconfirmed all counts and found zero new failures — this memo is the step after that.

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

**L10 — Two builders on disjoint files can each satisfy their own request and jointly violate an invariant
neither owned.**
Builder A made "a region is deleted the moment its words land" true; builder B (in the same round, on different
files) never touched that path. Nobody was assigned "does deleting-on-first-utterance interact with a founder who
draws several boxes before speaking into any of them" — it fell between two request-scoped build lanes, and both
builders' own green suites passed because the nominal sequence (draw, then immediately speak) never exercises two
open regions at once. The lens that found it was not reviewing "correctness" in general; it was told to hold a
**hate stance** on one named lens — the region lifecycle — and state a load-bearing objection before anything
else. Same shape as L1/L3 (a destructive predicate untested on its false branch), but the new fact is *where* the
gap came from: request-scoped ownership, not a missing test in one module.
Gate (N15): when a round splits founder requests across builders, the memo step names every pair of requests that
could touch the SAME piece of mutable state (here: "region marker lifecycle" was touched by request 1's build and
implicitly assumed stable by nothing else) and writes one cross-request case for each pair before the round closes
— not delegated to whichever lens happens to run.

**L11 — A builder's own "verified" claim is uncorrelated with the correctness of a destructive path; only a lens
built to distrust it finds those.**
Both round-4 build reports used confident, specific language ("nothing but the words remains", "23/23 verified in
the browser") about the exact mechanism the hate-stance lens then broke in one sitting. This is not a claim of
dishonesty — the reported tests really were green — it is that a builder narrates from the nominal path by
construction (they built it to work), so their own confidence is not evidence about the destructive branch. This
generalizes L1: L1 said the *gate* must cover the false branch; L11 says the *review step* must be staffed by a
lens whose brief is explicitly adversarial to the artifact, because a same-side reviewer inherits the builder's
blind spot for free.
Gate: any round with a build step also runs at least one lens whose brief states a stance (hate/adversarial) on a
NAMED dimension before it reads a single line of the diff — not a generic "review this" pass.

**L12 — An enumerated value-set crossing a client/server boundary is the same unowned-seam class as a scale
(L6), and needs the same cross-check.**
`ALLOWED_LANGUAGES` (client) and `STT_LANGUAGES` (server) encode the same fact twice with nothing comparing them;
`/health` does not report the server's list. L6 closed this exact class for a *scale* (raw RMS vs. display gain,
one function owns the mapping); the enumerated-set form was not recognised as the same bug family and shipped
anyway, so it is now an open row rather than a closed gate.
Gate (N16): every enumerated value that must agree across a network boundary is reported by the producer
(`/health` returns `languages`) and checked by a script the smoke/build step runs (`scripts/smoke.mjs` fails on a
mismatch), not left as two literal arrays with a comment pointing at each other.

**L13 — A skipped fix with a written reason is not the same failure as an unrecorded one, and the memo must keep
that distinction instead of flattening both to "still open".**
The round-4 fixer left 3 of 15 lens findings unapplied (the native multi-point line, the VAD noise-floor seeding,
the client/server language sync) and wrote why each was deliberately deferred rather than missed: each needs its
own gate/redeploy, not a drive-by edit inside a UI round. That is different from round 3's L9 finding (an
"accepted" row with no owner, functioning as a way to stop looking) — these three DO have an owner and a
re-decide round. The risk is that a memo written carelessly re-labels all open items identically and destroys the
distinction the fixer just made.
Gate: EVIDENCE rows distinguish "unmet, no owner" from "accepted, owner X, re-decide round N" (N14, unchanged) —
this round's memo must preserve the fixer's own labels, not re-flatten them.

## Anti-patterns (failure mode → catching gate)

| Anti-pattern | Failure mode observed this round | Gate |
| --- | --- | --- |
| Nominal-path-only suite | Inverted supersede predicate green in 22/22; lens found it by hand in one session | N9 truth-table / property gate on destructive predicates |
| Predicate buried in an async handler | `resolveTargets`'s comparison had no callable form until the fix extracted `isSuperseded` | Destructive rules are exported pure functions |
| Channel without a sink | `dropped`/`lastDropped` in VoiceStatus, nothing renders them | N10 — **closed round 3**: toast at the drop + `dropped N` in the tooltip |
| Barriered producer, unbarriered consumer | Stroke registered at pointer-up; assignment finalises mid-stroke → orphan | N2e slow-stroke-across-deadline case — **closed round 4c**: `runAssignment` waits for `currentStroke` too, gated in `test/unit/controller.test.ts` |
| A closing rule wired to a destructive action | Round 4a made "nothing landed here" delete the region, while the rule deciding "nothing can land here any more" (`isSuperseded`) stayed a mid-session predicate: every box drawn before the first spoken label was erased while latched | Round 4c: a region is deleted by a COMMIT or by the DISARM; closing only stops assignment. A destructive action needs its own trigger, never a predicate written for something else |
| A report written over its own payload | A failed retry wrote "⚠ STT" over a committed transcript whose only other copy was in controller memory: a reload lost the founder's words | Round 4c: `markFailed` returns `[]` when words have landed; failures report through the toast / `status.failed` / the retry button |
| Litter decided by reading content | The ghost sweep matched the "⚠ STT" TEXT, so it could neither remove an unbound warning the app wrote nor protect one the founder typed | Round 4c: `customData.voiceFailed`, cleared by a commit — same trick as `voiceRegion` |
| One axis answering two questions | The mic glyph was drawn on the VAD slider's 0.06 axis, where ordinary speech (0.08..0.48 measured) pins at 100%: the "reacts to volume" animation became a strobe | Round 4c: one function per axis in `level.ts` (`meterPercent`, `glyphLevel`), and the e2e asserts the glyph took several DISTINCT partial levels |
| A surface rendered outside its variable scope | The settings panel lives outside `.excalidraw`, so every `var(--color-*)` resolved to nothing: invisible buttons, a level bar that drew nothing at 100%, borderless inputs — on a panel with no console | Round 4c: literal fallbacks plus an e2e assertion on the COMPUTED paint, not on the class name |
| A gate that provides its own precondition | The two fit gates awaited `document.fonts.ready` in the page while the app awaited fonts nowhere: green by luck of timing | Round 4c: `fit.warmFonts()` in the app (boot + arm), and the tests call that |
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
- **N2e Pre-roll across a live stroke** — speech then a stroke slower than the pre-roll window → `orphans === 0`,
  words in that stroke's region, region not deleted. **Closed round 4c** (`test/unit/controller.test.ts`, describe
  "gate N2e …"); the e2e cannot reach it, which is why it survived two rounds as a browser-only gate.
- **N13 Kiosk re-measure** — real-mic cold start, suspend recovery, WAV cut accuracy on the panel. **Still open
  and now the only thing standing between the audio graph and "proven": round 3 removed a display gain from the
  capture path and re-measured nothing on the panel.**
- **N14 Accepted-row hygiene** — an "accepted" row carries an owner and the round it is re-decided in; a one-line
  fix may not be accepted; planning reads the open-rows table first (L9).
- **N15 Cross-request invariant case** — when a round splits founder requests across builders, the memo names
  every pair of requests touching the same mutable state and writes one cross-request case per pair before the
  round closes (L10).
- **N16 Client/server enumerated-value sync** — an enumerated value that must agree across a network boundary is
  reported by the producer and checked by an automated script, not left as two independent literal lists (L12).
  Concretely: `/health` returns `languages`, `scripts/smoke.mjs` fails on a mismatch against `ALLOWED_LANGUAGES`.
- **N17 Native multi-point conversion** — a native line/ellipse/diamond drawn while armed must convert to a
  region marker on ELEMENT FINALISATION, not on every intermediate `pointer-up`; today only the native RECTANGLE
  path has e2e coverage, so the line tool's first-segment-as-marker defect ships un-gated. **Unmet, owner: main
  loop** (round 4c looked at this and declined a 15-minute fix because the obvious guard risks never finalising
  the line at all — needs a deferred "convert when finalised" path plus a new e2e case).
- **N18 VAD noise-floor seeding** — a stream opened mid-utterance seeds its noise floor from voiced frames, so the
  effective threshold (3× floor) can sit above the level for ~4.7 s: the glyph fills but never turns green.
  **Accepted, owner: main loop, re-decide round 5** (mitigated today by `warmMicOnBoot` defaulting on; the real
  fix is a percentile/minimum seed in `vad.ts` with its own unit gate, not a drive-by edit).
- **N19 Undo-after-commit residue** — one Ctrl+Z after a commit no longer resurrects the region marker
  (round-4c's `NEVER` split fixed the destructive half), but a SECOND undo still leaves the reused placeholder "·"
  text alive with no owning session until the next reload's sweep. **Accepted, owner: main loop, re-decide round
  5** — a live but ownerless placeholder between commit-undo and reload is cosmetic (a reload always cleans it),
  but it is the kind of "accepted" row L9/N14 says needs a name and a date, not just a mention.
- Carried forward, still open: **N13 Kiosk re-measure** — real-mic cold start, suspend recovery, WAV cut accuracy
  on the panel; round 4 touched neither `capture.ts` nor `vad.ts`'s audio-graph internals, so this is unchanged
  since round 3 and remains the only gate standing between the audio path and "proven" (L8).
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

New in round 4:

- **region marker** — the dashed, `customData.voiceRegion`-stamped scaffolding a stroke produces. Never call it
  "the shape" or "the container" any more: a marker is deleted by the commit that replaces it or by the disarm
  sweep, and the words that land are a FREE text, unbound (`containerId: null`).
- **hate-stance lens** — a review pass briefed to state one load-bearing objection on a NAMED dimension before
  reading the rest of the diff. Distinct from a generic "review this" pass (L11): the brief itself is what makes
  it find destructive-path defects a same-side reader inherits blindness to.
- **persona lens** — a review pass that renders the actual artifact under a named real-world condition (device,
  distance, input modality) and reports what that condition actually shows, rather than reasoning about the code.
  Found the settings panel's undefined CSS variables and the mic glyph's wall-legibility problems — defects no
  assertion-based test had a way to phrase.
- **cross-request invariant** — a piece of mutable state two different founder requests, built by two different
  builders, both touch or assume stable. Not owned by either builder's request scope by default (L10); the memo
  step must name these pairs explicitly.

## Closed (a later gate retired these)

### Retired by round 4c

- **N2e/L3 — pre-roll deadline across a live stroke.** Closed: `runAssignment` now treats
  `currentStroke?.session === owner` like a queued conversion (the flush barrier now covers the *consumer*, not
  only the producer), and `convertStroke`'s `finally` re-runs it. Proof: `test/unit/controller.test.ts` → "gate
  N2e — a stroke that is still under the pen when the deadline passes"; verified to fail (`orphans: 1`, region
  deleted under a "No speech heard" toast) with the pre-fix guard restored. Not reachable from the e2e — the
  slowest scripted stroke is ~0.4 s against a 1.5 s pre-roll — which is why it survived two rounds as a
  browser-only-looking gate that was actually a `test/unit` gate the whole time.
- **The round-4a regression this closure also caught: "closing wired straight to deleting."** Round 4a made "a
  region nobody spoke into" die the moment ANY later utterance committed elsewhere (`isSuperseded` doubled as the
  delete trigger), erasing every box the founder drew before the first spoken label while still latched. Closed:
  a region is deleted by its own COMMIT or by the DISARM sweep (one undoable update, one counted toast); closing
  only stops assignment. Proof: `test/unit/controller.test.ts` → "a region the founder drew and never spoke into"
  (survives while latched, only the disarm removes it) + "sweeps several at once with a toast that counts them".
- **A report written over its own payload.** Closed: `fit.markFailed` returns `[]` once the text already carries
  a landed transcript. Proof: `test/unit/fit.test.ts` → "never writes over words that already landed";
  `test/unit/controller.test.ts` → "leaves an orphan's transcript alone when a later take into it fails".
- **Litter decided by reading content.** Closed: `customData.voiceFailed` stamps a failure warning, cleared by a
  commit; `persist.ts` sweeps by the stamp, never by matching "⚠ STT" text, so a founder-typed warning survives a
  reload untouched. Proof: `test/unit/persist.test.ts`, `test/unit/fit.test.ts` (stamp/clear-stamp cases).
- **One axis answering two questions.** Closed: `level.ts` owns `meterPercent` (settings bar) and `glyphLevel`
  (mic glyph) as two named functions on two named scales, after the wall-panel lens measured ordinary speech
  pinning the glyph at 100 % on the settings-panel's 0.06 axis. Proof: `test/unit/level.test.ts`, and the e2e
  "toolbar latch" case now asserts at least three DISTINCT partial levels rather than a binary on/off.
- **A surface rendered outside its variable scope.** Closed: every `var(--color-*)` the settings panel's CSS
  reads now carries a literal fallback, because the panel renders outside `.excalidraw` where the library's theme
  variables do not exist. Proof: the main-menu e2e case now asserts the level bar's fill and the action buttons'
  COMPUTED background color and the inputs' computed border are non-default, not just that a class name is
  present.
- **A gate that provides its own precondition.** Closed: `fit.warmFonts()` (measure once, then
  `document.fonts.ready`, cached) is awaited by `App` at boot and by `armBody` before arming; the two e2e fit
  gates now call that instead of doing their own in-page font warm-up, so the gate no longer passes under a
  precondition production never provided.

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

## Round 5 lessons

- **L14 — "every N ms, abort the previous one" starves when N < latency.** The brief's interim policy was written as
  a cadence; on the real server the round trip (~1.6 s) exceeded the 1200 ms interval, so every slice was killed by
  its own successor and the founder would have seen nothing at all. The unit tests could not see it (a fake
  transcribe answers instantly) and only a real-surface run with request logging did. Rule: a periodic request whose
  period is not provably longer than its own latency must be **chained off its answer**, not off a timer.
- **L15 — decoupling two decisions silently merges the cases that were told apart by their ORDER.** Round 4 resolved
  the target at send time, which is what made "the founder deleted the region while the words were in flight" (drop,
  G5c) different from "the region was already gone" (orphan, N2d). Moving the resolution after the answer collapsed
  both into "orphan" — a regression the full e2e caught and neither the unit suite nor the new gates would have.
  Rule: when a step moves later in time, list every behaviour that was reading the old ORDER as a fact.
- **L16 — rendering as a function of state is what makes a speculative write undoable.** The interim preview is
  written into a region the assignment may still take away. With per-transition patches that needs an "undo the
  preview" path per source state; with `renderEntry(parts → interim → placeholder)` it is one call on the region that
  lost it. This is the same shape as the round-4a defect (a predicate that doubled as a deleter) seen from the other
  side.
- **L17 — an unreachable retry is not a retry.** `stt-server`'s `except OSError:` bind-retry had never run: uvicorn
  logs the bind failure and raises `SystemExit`. It took a redeploy that raced the old process to find out, with the
  service down until someone looked. Rule: a recovery path needs a gate that exercises the exception it claims to
  catch, or it is decoration.
- **L18 — a "before" number needs the old build, not arithmetic.** The pen-up→words claim is 1874 ms → 80 ms because
  the same spec was run against `17a3a1d` in a throwaway worktree on a second port. Deriving the before number as
  "penUp + sttLatency" would have been proof by construction (round-1 vocabulary) and would also have been wrong by
  the conversion time.

### Vocabulary added in round 5

- **provisional region** — `assign()`'s answer with `nowMs = now`, i.e. before `final`. Legitimate to RENDER into
  (dimmed, stamped, `NEVER`) and never legitimate to commit into.
- **cosmetic write** — a scene update the founder did not cause: `CaptureUpdateAction.NEVER`, stamped so a reload can
  sweep it, and never counted in a status field that means "a take finished".
- **chained cadence** — a repeating request scheduled from the previous answer rather than from a clock, so it cannot
  overtake itself (L14).
