# RETRO — 0.2.0 collab, phase 1 → what phase 2 (voice port) and phase 3 (boards page) must know

Cycle shape: three builders on disjoint file sets (storage-backend / excalidraw-app data layer /
fleet-infra compose+nginx) working off one written contract (`euidos/docs/collab-plan.md`), zero cross-edits,
one real contract mismatch caught at deploy (env var names) → deploy stage with a throwaway rehearsal before
touching the host → live two-browser Playwright acceptance, 3/3 green → adversarial security + correctness review
(one lens: exposure/identity; one lens: the data-layer swap against upstream's Firestore semantics) → fix pass
(9 applied, 2 explicitly skipped with reasons) → redeploy → re-proof, 3/3 green again, zero flakes.

## What earned reuse

- **Contracts-first, disjoint ownership, one integration point.** Same pattern the voice-areas casebook (0.1.0)
  found worked: three builders never touched each other's files; the ONE seam that broke (env var names) broke
  exactly where the contract was silent (it didn't name env vars) rather than where it was explicit — a signal
  that the written contract, not vigilance, is what prevented cross-builder drift.
- **A throwaway rehearsal before touching the live host.** The deploy stage ran the whole stack under its own
  project name on a spare port on dev-woo, proved routing and both identity branches there, and the actual
  production deploy was a single clean run with a seconds-long interruption. Reuse this for phase 2's kiosk
  redeploy and phase 3's boards-page cutover.
- **A hate-stance / adversarial lens finding what the nominal green suite could not see.** Both MUST findings
  (stored XSS, lost-update race) are defects on paths the builders' own green tests never walked: the client's
  `euidosStorage.ts` was proven only against a mocked fetch (storage-backend did not exist yet during that
  build), and the storage backend's own 41-test suite was written by the same person who wrote the server, so a
  same-side review inherited its author's blind spot. This is 0.1.0's L11 recurring verbatim in a different
  codebase — the lesson generalizes past one project.
- **Reproduce the "before" number, don't compute it.** The lost-update race was reproduced live against the
  deployed pre-fix image on a throwaway Postgres (two readers both got version 1, final stored state lost
  rectA), not reasoned about — the same discipline as 0.1.0's L18 ("a before number needs the old build, not
  arithmetic").

## What phase 2 (voice tool port) must know

**G-P2.1 — Save cadence is unchanged and voice hasn't touched it yet.** `PUT /api/rooms/:id` still lands
13.9–14.2 s after the triggering edit (the app's own `SYNC_FULL_SCENE_INTERVAL_MS = 20 s`, `leading:false`).
0.1.0's round 5 cut the voice tool's OWN pen-up→words latency from 1874 ms to 80 ms by decoupling transcription
from region assignment — but that work has no bearing on when the SCENE reaches the new backend. If a founder
complains "my voice-labelled box didn't save for 14 seconds", that is expected, unchanged, cross-cutting
behaviour, not a phase-2 regression. Do not re-derive this number; it is measured above in EVIDENCE.

**G-P2.2 — `PUT /api/rooms/:id` now has a 409 conflict path the voice-areas code never saw.** 0.1.0's controller
was built against `whiteboard/`'s own persistence layer (`persist.ts`, vanilla localStorage), which never
conflicts with another writer. Once the port lands in `excalidraw-app/`, the SAME scene the voice controller
mutates is saved through `euidosStorage.ts`'s GET→reconcile→PUT with a `baseVersion` retry (up to 5 attempts on
409). Two things phase 2 must verify, not assume: (a) the voice controller's own writes — placeholder creation,
commit, discard, disarm sweep — all go through the SAME save path as a manual edit (they should, since it's all
one Excalidraw scene), so they inherit the retry for free; (b) `persist.sweepGhostPlaceholders` (0.1.0's ghost
sweep for interrupted takes) must run against data loaded via `loadFromFirebase`-equivalent (`euidosStorage.ts`),
which 0.1.0 never exercised — it only ever read the vanilla `excalidraw` localStorage key directly.

**G-P2.3 — `scenes.elements` is `json`, not `jsonb`, specifically so a NUL survives.** If phase 2's STT pipeline
or any transcript-fitting code path can produce a NUL byte in text content (unlikely from Whisper output, but
0.1.0's own hallucination blocklist shows STT output is not always clean text), this phase-1 fix is why it will
not 500 the save. Do not "clean up" the schema back to `jsonb` without re-checking this.

**G-P2.4 — The `/stt/` proxy strips identity headers now; check the voice controller's actual request shape
against it.** Phase 1's fix blanks `Cookie`/`Authorization`/`Cf-Access-*`/`Tailscale-User-*` on BOTH nginx `/stt/`
blocks, and does NOT narrow the location past the whole `/stt/` prefix (deliberately deferred — see DESIGN).
0.1.0's `stt.ts` posts multipart audio with no auth header at all, so this should be transparent — but phase 2 is
the first round to actually exercise `/stt/` through THIS nginx (0.1.0's kiosk build talked to
`100.81.33.83:8770` directly, never through euidos-internal's proxy). Confirm the multipart upload still works
through the stripped-header path before assuming it does.

**G-P2.5 — 0.1.0's own open rows are not closed by this phase and must not be assumed closed.** N13 (kiosk
real-mic re-measure), N17 (native multi-point line conversion), N18 (VAD noise-floor seeding), N20 (bound interim
preview growth risk), N21 (the one-off "toolbar latch" flake with no trace) are all still open per
`whiteboard/.re0/iteration/0.1.0-voice-areas/RETRO.local.md`. Phase 2 is a PORT, not a rewrite — carry these
rows into the new location rather than re-discovering or silently dropping them.

## What phase 3 (boards page) must know

**G-P3.1 — `wall` is now a restricted identity; the boards page must not assume every visible identity can
delete/rename.** Phase 1's fix means `via:"wall"` (any tailnet device with no `Tailscale-User-Login` — this
includes the wall kiosk itself once it's cut over, and any tagged device) gets 403 on `PATCH`/`DELETE
/api/boards/:id`. If the boards page renders rename/delete controls unconditionally, they will 403 for wall
sessions with no explanation shown to the user. Design the UI to either hide those controls when
`GET /api/me` returns `via:"wall"`, or handle the 403 with a real message.

**G-P3.2 — An idle `#room=` link no longer creates a board row; `roomKey === ""` boards from BEFORE this fix
still exist and cannot be backfilled.** Phase 1 stopped the specific growth pattern (opening a link and never
drawing → auto-created "Untitled" board with an empty, unbackfillable `roomKey`), but any such rows created
during earlier testing rounds are still in the table (found: 4 of 10 in this round's own testing, since
soft-deleted). The boards page's "copy link" action has no working route for a board whose `roomKey` is empty —
either filter these out, or add the backfill route 0.1.0's contract notes flagged as missing.

**G-P3.3 — `elementCount` is a stored column now, not computed at read time.** `scenes.element_count` is written
by the storage backend on every `PUT /api/rooms/:id`, sourced from live (non-tombstoned) elements. If phase 3
adds any OTHER write path to the `scenes` table (bulk import, admin tooling), it must also write this column or
the boards list will show a stale count.

**G-P3.4 — CSRF and Content-Type enforcement now apply to every state-changing route the boards page will call.**
`POST /api/boards`, `PATCH /api/boards/:id`, `DELETE /api/boards/:id` all now require same-origin (or no
`Sec-Fetch-Site`/`Origin` at all, which is what curl and the current Playwright rig send) and
`Content-Type: application/json` on the JSON routes. A plain `fetch()` from the app already satisfies both
(same-origin, and the app's fetch calls set JSON content type) — but any phase-3 test harness that talks to the
API with a bare `fetch`/`curl` from a DIFFERENT origin (e.g. a local dev server proxying cross-origin) will get
403s that look like an auth bug and are actually the CSRF guard working as designed.

**G-P3.5 — Two identity branches are still unverified by an agent and need the founder, not a build round.**
Tailscale Serve injecting `via:"tailnet"` for the founder's own (untagged) device, and the Cloudflare Access
branch end-to-end with a real login (`via:"access"`), are both proven only up to the edge from this box (dev-woo
is a tagged device, so it always reads as `wall`; no Access JWT can be minted from a non-interactive session).
Phase 3's acceptance test (collab-plan.md: "two users … via the tailnet origin … create/open/rename/delete")
needs these two branches working for real, not just at the header-forgery level phase 1 proved. **This is a
5-second manual check the founder should do before phase 3 planning starts**, not something to route around with
more agent-side header injection.

## Lessons

**L1 — A silent contract (no stated env var names) is exactly where cross-builder drift happens, even under
strict file-ownership discipline.** Neither builder was wrong per their own spec; the plan simply didn't specify
this seam, so each builder filled it from a different source of truth (the service's own README defaults vs. the
platform's naming convention doc). Every other seam the plan DID specify (routes, table shapes, identity order)
came through with zero drift. Gate: when a plan hands three builders disjoint files against one contract, the
memo step that reviews the contract before build starts should flag every configuration surface (env vars, port
numbers, file-naming conventions) the plan leaves unstated, not just the API routes.

**L2 — "Verified against a mocked fetch" is not the same claim as "verified against the real backend," and the
gap is exactly where a MUST-severity defect hid.** The app builder's own report said as much up front ("the first
real cross-check of routes, status codes and the file-id shape happens at phase-1 acceptance") — this was a
declared risk, not a missed one, and it is exactly where the lost-update race lived (the mocked fetch could not
reproduce a real Postgres UPDATE racing a stale read). Same shape as 0.1.0's L8 ("a capture path proven by
construction is not proven"): a parallel-build round's first REAL integration point is where "green" stops
meaning what it usually means, and it deserves its own review pass, not folding into the general acceptance run.

**L3 — A recovery path with no route is a support burden, not a decision.** Restricting `wall`'s delete power
(G-P3.1 above) means the ONLY recovery for a soft-deleted board is `UPDATE boards SET deleted_at = NULL` on the
host — documented in the storage README, but not a route. This is fine for phase 1 (nobody but agents delete
boards yet) and becomes a real gap the moment staff use the boards page in phase 3. Gate: phase 3 either ships a
`/restore` route or an admin view before shipping delete in the UI, not after a founder asks where their board
went.

**L4 — The founder's own framing ("nothing deployed") did not match the live host state at resume, and the
discrepancy was worth surfacing rather than silently reconciling.** At resume-time, the host was already running
the full phase-1 stack at the exact commit that would have been "the deploy" — either a deploy happened between
the pause and the resume, or the pause message was inaccurate. Nothing was broken by this (the bundle hash on
the wire matched a fresh cold build from the same commit, so it wasn't a stale leftover either) but a memo that
quietly assumed "must have deployed since, no need to mention it" would have hidden a process gap. Gate: when a
resumed task's live state contradicts the framing that paused it, name the discrepancy in the memo instead of
resolving it silently — the founder decides whether it matters, not the agent.

## Vocabulary carried from 0.1.0, still load-bearing here

**contracts-first / disjoint ownership** (RETRO 0.1.0 "what earned reuse"), **hate-stance / adversarial lens**
(0.1.0 L11), **proof by construction** (0.1.0 vocabulary — "offline arithmetic or a fake device standing in for
the real surface. Not proof." — here: a mocked fetch standing in for the real Postgres-backed service).

New this round:

- **silent contract seam** — a configuration surface (env var names, here) a written contract leaves unstated,
  where disjoint builders will each supply their own default and only the integration stage catches the drift.
- **ambient identity** — identity carried by the connection (nginx-stamped headers) rather than a cookie the
  browser could withhold; the reason CSRF needed its own guard even with no session cookie anywhere in the
  system.

## Phase 2 (voice tool port) — cycle shape

Two builders in sequence (module port with no wiring, then wiring + kiosk-script/casebook migration +
deploy-prep), each ending in green unit/typecheck/lint; a hate-stance adversarial review against the shipped
wiring found 13 findings (2 MUST, 5 SHOULD, 6 NICE — one SHOULD later downgraded to no-change-needed); a fix
pass applied 11 and reasoned-skipped 1; a same-day cold-run resume from a fresh worktree re-derived the build
and unit/e2e numbers and caught the fix's one remaining gap (deploy never happened, so the live voice e2e still
fails against the host) rather than assuming the review closed everything. The deploy step itself never
executed — refused twice by the auto-mode permission classifier under `[Production Deploy]`, and per the
founder's own rule, no agent decomposed the deploy script into its ssh/scp/docker-load legs to route around
that gate.

## Gates for phase 3 (boards page and identity) — carried in addition to G-P3.1–G-P3.5 above

**G-P2.6 — Phase 3 inherits a scene that can carry voice scaffolding, not just plain elements.** Any admin
tooling, bulk import, or boards-page preview phase 3 adds must not treat `customData.voiceRegion` /
`voiceInterim` / `voiceFailed`-tagged elements or `PLACEHOLDER_FRAMES`-text as ordinary content — they are
mid-take scaffolding that `sweepGhostPlaceholders` (now version-aware, see G-P2.7) is the only code path
entitled to delete. A boards-list thumbnail or preview renderer that snapshots `elements` directly, without
running the sweep, will show a half-finished dictation as if it were a saved shape.

**G-P2.7 — The sweep is now a REAL versioned edit and reaches the wire; phase 3's own scene-mutating code
(if any — e.g. a bulk-delete or restore route) must not race it.** The review/fix round made
`sweepGhostPlaceholders` bump version/versionNonce/`updated` specifically so it wins reconciliation and gets
broadcast+saved (fixed under `c5624afc`, see EVIDENCE). Any future write path phase 3 adds to `scenes` (the
`/restore` route floated in phase-1's L3, or an admin bulk edit) needs the same GET→reconcile→PUT discipline
`euidosStorage.ts` already has — this phase did not touch that discipline, only the payload the client sends
into it.

**G-P2.8 — The tab-close scaffolding-litter path is unfixed and phase 3's boards UI can make it worse.** Closing
a tab mid-dictation still PUTs the scaffolding to the room (Collab's `beforeunload` clones the scene before
`VoiceTool`'s own cleanup can run — provably unwinnable, see DESIGN). If phase 3's boards page adds a "close
board" or "leave" action that programmatically triggers the same save path faster than today's idle tab-close,
it inherits this exposure at a higher frequency. The mitigation is entirely in the load-path sweep (G-P2.7);
phase 3 should not assume a UI-level "are you sure" dialog fixes anything here.

**G-P2.9 — The sweep's liveness signal (30 s `element.updated` heartbeat) is a residual risk, not a closed
gate.** A live peer's take can still be destroyed if the speaker goes silent (a long pause mid-utterance, or the
placeholder's own frame timer stalls) for more than `LIVE_SCAFFOLDING_MS` while another peer's join sweeps the
scene. Nobody has reproduced this live; it is a design-time gap named in DESIGN's "not done" list. If phase 3
or a later round adds real multi-peer voice usage (more than one microphone active in one room), re-open this
with a genuine two-peer test — neither the unit suite nor the single-browser e2e can see it.

**G-P2.10 — `persist.ts` still exports three functions nothing may call
(`createPersister`, `loadInitialData`, `libraryAdapter`).** Carried forward from phase 2's own DESIGN
deviations, unresolved by the review/fix round (it was reasoned as a design decision, not a bug). Phase 3,
which owns the boards-page UI and is the next round to touch load/save semantics, is the natural place to
either wire a genuine need for them or delete them — CLAUDE.md's "do not leave a module in src/ that nothing
imports" argument applies.

**G-P2.11 — Phase 2 is NOT deployed; do not plan phase 3 acceptance against a live voice tool that isn't
there yet.** `euidos-internal` serves `cff7269f` (phase 1 only) as of this memo. `board.euidos.ai` still 302s
to Access (unaffected). The wall kiosk `100.102.3.47` was never contacted by any phase-2 agent and its cutover
remains entirely deferred, unchanged from phase 1. Acceptance step 5 of the plan (hosted app, tailnet origin,
fake mic through `/stt`) and the two-peer collab-smoke re-run are both still open, blocked on the deploy alone
— everything code-side that could be proven without shipping was (see EVIDENCE).

## Gates for the deferred wall cutover (100.102.3.47), carried forward from 0.1.0 with new paths

0.1.0's own open rows are **not closed by phase 2** — it was a port, not a rewrite, and none of these rows was
in scope. They now live at `euidos/casebook/iteration/0.1.0-voice-areas/RETRO.local.md` (git-mv'd from
`whiteboard/.re0/iteration/0.1.0-voice-areas/`) instead of under `whiteboard/`, which no longer exists:

- **N13 — kiosk real-mic re-measure.** All of phase 2's latency numbers (R5a 83–89 ms) are from a fake mic fed
  by WAV fixtures through Playwright (`euidos/e2e/voice/fixtures/`, moved from `whiteboard/test/fixtures/`).
  Nobody has re-measured on the wall kiosk's actual microphone and room acoustics since 0.1.0. Blocked on the
  wall cutover itself (deferred), so this cannot close before then.
- **N17 — native multi-point line conversion.** Unchanged by the port; `stroke.ts` carries the same
  recognition logic as 0.1.0 (now at `excalidraw-app/voice/stroke.ts`).
- **N18 — VAD noise-floor seeding.** Unchanged; `vad.ts` (now `excalidraw-app/voice/vad.ts`) carries the same
  algorithm. Worth re-checking once real-kiosk audio (N13) is available, since seeding quality depends on the
  room's actual noise floor, not the fixture WAVs' silence.
- **N20 — bound interim preview growth risk.** Unchanged; `controller.ts`'s interim-preview sizing logic
  (now `excalidraw-app/voice/controller.ts`) was ported without modification to this behaviour. Phase 2's own
  G-P2.9 (above) is a related-but-distinct risk (liveness of the scaffolding across a sweep, not the interim's
  own growth) — do not conflate the two when re-opening either.
- **N21 — one-off "toolbar latch" flake with no trace.** Never reproduced in 0.1.0, and not reproduced in
  phase 2's four full e2e runs (0 flakes across mid-port, final wiring, post-fix, and the cold-run resume) —
  the absence of a recurrence is worth recording, not the same as closing it, since 0.1.0's original occurrence
  also had no trace to compare against.

## Lessons

**L5 — A test written to prove a gate can certify the defect it was meant to catch, if it pins the SYMPTOM
(no version churn) rather than the INVARIANT (the delete must win reconciliation).** `collab-sweep.test.ts`'s
original `expect(marker.version).toBe(7)` read as a reasonable "no gratuitous churn" assertion and was in fact
asserting the exact condition (identical version+nonce) that makes `reconcileElements`'s tie-break discard the
tombstone. Green in CI, cited as G-P2.2 closed in the phase-2 wiring report, and wrong. Gate: when a unit test
is the only thing standing between a design and a live multi-peer defect, write it against the real library
function the design has to survive (here: import the actual `reconcileElements`, not a hand-rolled shape
assertion) — the same shape as this round's own L2 recurring from phase 1's own EVIDENCE.

**L6 — A cold-run resume that re-executes the live artifact (not just the test suite) is what caught the
deploy gap; a re-run of only the tests would have re-confirmed 194/194 and missed it entirely.** The unit
suite, typecheck and lint all stayed green through every stage of phase 2, including after the fix commit —
none of them could have told anyone the fix was never shipped. Only `voice/live-smoke.mjs` run against the real
tailnet origin surfaced `window.__excalidrawVoice` never appearing, because the served bundle hash didn't match
the local one. Gate: when a task's outcome depends on host state (a deploy, a config apply, a migration run),
the memo step's evidence must include a probe of the LIVE artifact's identity (bundle hash, deployed commit,
`/api/health` version), not just the build-time test suite — this generalizes 0.2.0 phase 1's own L2 one level
further up the stack (mocked fetch → real backend; here: local green build → real deployed bundle).

**L7 — A permission classifier can escalate from refusing one command to refusing an entire session under the
same label, and that is worth naming rather than working around.** The review/fix round's Bash tool was refused
not just for the deploy script but for every subsequent call (including `git status --porcelain`) under
`[Production Deploy]`, after the first refusal. No agent attempted to bypass this by reframing commands or
using a different tool; each round instead stopped and named the block precisely (which command, which label,
what it would have proven). Gate: when a disruptive-action gate fires, treat a broadened refusal on unrelated
read-only commands as a session-level side effect to report, not a second wall to route around.

## Vocabulary added this round (phase 2)

- **symptom vs. invariant test** — a gate that asserts the visible absence of churn (a version number staying
  put) rather than the property that actually matters (a delete winning reconciliation); the first can be green
  while the second is false.
- **live-artifact probe** — checking what a deployed bundle actually IS (its hash, a debug global's presence)
  rather than what the build pipeline that produced a candidate artifact reports; the only check in this round
  that caught the undeployed-fix gap.

## Phase 3 (boards page and identity) — cycle shape

One build round, shipped and unit/e2e-green against a throwaway rehearsal of the real
`fleet-infra/stacks/euidos-internal` compose; a hate-stance adversarial review (18 findings: 2 MUST, 8+2
SHOULD, 6 NICE) driven LIVE against that same rehearsal stack, not read-only inspection — every finding cites a
reproduced browser action, a captured network call, or a live curl, the same discipline phase 1's review used
for its two MUST findings; a fix round applied 20 of 22 applicable fixes and named the 2 skipped with reasons;
a same-day cold-worktree resume re-ran the full stack from scratch and surfaced one more real gap (the e2e
suite cannot be re-run against a live stack without a reset) that neither the build nor the fix round's own
green suites could have shown, the same shape as phase 2's L6.

## What earned reuse

- **The rehearsal-before-touching-the-host discipline, now proven across three consecutive phases.** Phase 1
  rehearsed the deploy; phase 2's cold-run resume rehearsed the build; phase 3's review AND its fix round both
  ran the entire compose stack under a throwaway project name, on a loopback-only port, torn down with `-v`
  every time. Zero contact with `euidos-internal` or the wall kiosk across all three phases of this whole
  iteration. This is no longer "worth reusing" — it is now the iteration's default mode, and should be named as
  a standing rule for phase 4+ rather than re-justified each time.
- **A hate-stance review finding defects the nominal green e2e suite could not, for the third phase in a row.**
  Both MUST findings (Back-button data loss, the `roomKey:""` open-affordance gap) are on interaction paths the
  builder's own 8-test suite exercised in the HAPPY direction only (Back was never pressed mid-draw; the legacy
  row's Copy link was tested, its Open button was not). Same shape as phase 1's L2 and phase 2's L5: a green
  suite proves the paths it walks, not the ones adjacent to them.
- **A real finding surfaced by RUNNING the thing, not by reading the diff.** The nginx `Host`/`Origin` port
  mismatch was found because the e2e suite's own `POST /api/boards` 403'd on a non-standard port — the reviewer
  reproduced it with a bare curl before writing it down, rather than reasoning about nginx config in the
  abstract. Same discipline as phase 1's L2 lost-update reproduction and phase 2's L6 live-artifact probe: an
  infrastructure defect this specific does not show up by reading `nginx.conf`.

## What phase 4 / wall-cutover / board-import must know

**G-P3.6 — The e2e boards suite is stateful and cannot be re-run against a live stack without a reset.**
`euidos/e2e/boards/boards.spec.ts` assumes a fresh, empty Postgres volume (it says so at the top of the file);
a second consecutive run against the SAME `boards-e2e` stack fails at "alice lands on an empty boards page"
because run 1's rows are still there. This is a suite-design gap, not an app defect, but it means CI retries or
a `rehearsal.sh up` left running between review passes WILL produce a false failure that looks like a real
regression. Fix (not done, next round's job): a `TRUNCATE`/`DELETE` step in `rehearsal.sh`, or a global
Playwright setup hook.

**G-P3.7 — The nginx `Host $host` / `Origin` mismatch is real, reproduced, and NOT fixed.** Any future rehearsal,
QA harness, or ephemeral environment that serves the app on a non-default port will trip phase 1's own CSRF
guard on every write, because `proxy_set_header Host $host;` strips the port while `Origin` carries it.
Production (both front doors on 443) never sees this. `fleet-infra/stacks/euidos-internal/nginx.conf` is one
word away from closed (`$http_host` instead of `$host`) but is out of every phase-3 builder's file scope — carry
this forward explicitly rather than re-discovering it the next time a rehearsal runs on a non-443 port.

**G-P3.8 — The phase-1 RETRO L3 gate (a `/restore` route or admin view before delete ships) is STILL unmet, now
with delete actually shipped in the UI staff will use.** Phase 3 built the confirm dialog to say so honestly
(no undo, needs a database edit) and, in the fix round, made a save-into-a-deleted-board name the cause instead
of showing a generic error — but neither substitutes for the route the phase-1 RETRO asked for BEFORE shipping
delete. This is the third memo in this iteration to carry this row forward unclosed; it should not become a
fourth without either the route landing or the founder explicitly accepting the dialog text as sufficient.

**G-P3.9 — G-P3.5 (the two identity branches — `via:"tailnet"` from an untagged device, `via:"access"` after a
real login) is STILL unverified end-to-end, across three phases now, and remains the one gate no agent can
close.** Every rehearsal in this iteration (phase 1's deploy proof, phase 3's review and fix round) proves
identity only up to the header-forgery level, because dev-woo is a tagged device and no non-interactive session
can mint a real Cloudflare Access JWT. This is not a build-round task; it is a 2-minute founder walkthrough
(see collab-plan.md's founder test) that should happen before or alongside the wall cutover, not be re-flagged
a fourth time.

**G-P3.10 — The wall's authorization model is ownership-blind, not identity-blind, and phase 4 (import /
cutover) should design around the ACTUAL rule, not the naive one.** Delete is gated on `via !== "wall"`, not on
who created the board — so ANY signed-in staff member can delete a board the wall itself created, and the wall
can create boards nobody but a human can clean up if abandoned. This shape is fine at today's scale (a handful
of internal boards) but a bulk import of the wall's history (deferred, see collab-plan.md) will multiply
wall-created rows; whoever designs the import should decide up front whether that's still fine at N boards, not
assume phase 3's "still fine" judgment scales.

## Lessons

**L8 — A stated harm in a review finding is worth re-checking against the actual authorization rule before
applying the suggested fix, not just the finding's own framing.** The review's NICE finding on the wall's
"New board" button reasoned from "rows only a signed-in person can remove" — but the fix round checked the
backend's actual delete rule (`via !== "wall"`, not ownership) and found the premise false: any signed-in
person can already remove ANY board, wall-created or not. The fix was correctly skipped, with the reasoning
recorded, rather than applied on the strength of the finding's framing alone. Gate: a review finding's proposed
fix should be checked against the code path it claims to guard, not accepted because the finding's prose sounds
right — the same discipline phase 1's L2 applied to test claims applies equally to review claims.

**L9 — Running a suite twice, not once, is what surfaced a suite-design gap three green single-runs had never
shown.** The build round's 8/8 and the fix round's 11/11 were both first-and-only runs against a freshly-started
stack; only the cold-worktree resume's explicit "run it again" step (mirroring phase 2's L6 cold-run discipline)
hit the "second run against the same stack" case and found the suite cannot survive it. Gate: a memo step that
verifies a rehearsal-backed e2e suite should include one deliberate SECOND invocation against the SAME stack
instance, not just a fresh one — a single green run proves the happy path exists, not that the suite is
reusable across CI retries or iterative review passes.

## Vocabulary added this round (phase 3)

- **ownership-blind vs. identity-blind authorization** — a rule gated on WHO you are (`via`) rather than WHO
  created the resource; worth naming explicitly because a review finding phrased in ownership language
  ("only X can remove it") can be flatly false against an identity-blind rule, and the mismatch is easy to miss
  without checking the actual guard clause.
- **suite-design gap** — a defect in the TEST HARNESS's own assumptions (here: no reset between runs) that
  produces a false failure indistinguishable from an app regression on a second invocation; distinct from both
  a shipped-code defect and a finding against the reviewed diff.
