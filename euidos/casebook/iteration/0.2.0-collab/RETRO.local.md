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
