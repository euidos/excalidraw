# DESIGN — 0.2.0 collab, phase 1 (infrastructure and persistence)

Understood as: replace excalidraw-app's Firebase backend with our own service so boards persist on
euidos-internal, are reachable from both the public (Cloudflare Access) and tailnet origins with edge-derived
identity, and survive a reload — with no voice tool and no boards-page UI yet (those are phase 2 and phase 3).
Binding plan: `euidos/docs/collab-plan.md` (routes, table shapes, identity order, nginx layout, phase-1
acceptance). Weight: **full** — three builders (storage backend, app data-layer swap, infra/compose/nginx) working
off one contract in parallel, then a deploy stage, then an adversarial review-and-fix pass, all in this round.

## Thesis

`excalidraw-app` keeps every UI and collab-relay behaviour it already has (socket.io room relay, per-room
encryption, `#json=` share links); only the STORAGE side changes. `data/euidosStorage.ts` exports the same five
names `data/firebase.ts` exported (`isSavedToFirebase`, `saveToFirebase`, `loadFromFirebase`,
`saveFilesToFirebase`, `loadFilesFromFirebase`), so `Collab.tsx`/`App.tsx`/`data/index.ts` change by their import
line only. The Firestore transaction that used to merge concurrent saves moves client-side (GET → reconcile →
PUT) against a hand-rolled Node 22 / `pg` service (`euidos/storage-backend`) that stores boards, scenes (one row
per board, a version counter), files and `#json=` blobs on Postgres. Identity is never carried by the client —
it is stamped by nginx per listener (Cloudflare Access JWT on the tunnel block, Tailscale Serve headers on the
tailnet block, "wall" when neither is present) and read by the backend from those headers alone.

## Scope

In (phase 1, per collab-plan.md):
- `euidos/storage-backend/`: the storage API (boards index, scenes, files, `#json=` blobs) on Postgres, the
  plan's three-step identity order, idempotent startup migrations, non-root Docker image with `/api/health`.
- `excalidraw-app/data/euidosStorage.ts`: Firebase-name-compatible module over `/api`, runtime-derived origins
  (no baked hostname), production env trimmed (no Firebase, no tracking, no Plus/AI promos beyond what upstream
  gates by build mode).
- `fleet-infra/stacks/euidos-internal`: compose gains `db` (postgres:16-alpine), `storage` (our image),
  `room` (`excalidraw/excalidraw-room`, pinned by digest); nginx gets two server blocks (`:80` tunnel, `:8081`
  tailnet) proxying `/`, `/api/`, `/socket.io/`, `/stt/` identically except for which identity headers each
  strips/trusts; Tailscale Serve keeps mapping `127.0.0.1:18090 → web:8081` unchanged.
- Deploy + acceptance: build the app and the storage image from one fork commit, ship both, run the plan's
  two-browser Playwright acceptance against the live tailnet origin.

Out (phase 1, deferred to phase 2/3 per the plan): the voice tool (still on `whiteboard/`, untouched, undeployed
by this round), the boards-page UI, per-board permissions, cutting the wall kiosk over to the hosted app.

## Contract, as specified

`euidos/docs/collab-plan.md`'s Storage API table and identity-resolution order, unchanged by this round except
where noted under "Deviations" below. The three builders worked from that one contract with disjoint file sets
(storage-backend / excalidraw-app / fleet-infra) and zero cross-edits before the deploy stage reconciled the one
real mismatch (env var names — see Deviations).

## What was built (as-built architecture)

```
browser (staff)  ──https──▶ Cloudflare edge ──Access──▶ tunnel euidos-board ─┐
wall / tailnet   ──https──▶ Tailscale Serve (euidos-internal.…ts.net:443) ───┤
                                                                            ▼
                     nginx `euidos.internal`  (two server blocks: :80 tunnel, :8081 tailnet)
                       /            static app build (excalidraw-app/build, cff7269f)
                       /api/        storage backend  (euidos/boards-storage:cff7269f, :3000, node user)
                       /socket.io/  excalidraw-room  (sha-03ff435@sha256:2fe999f…, relay only)
                       /stt/        desktop STT (100.81.33.83:8770) — credentials now stripped both directions
                     postgres:16-alpine `db`  ◀── storage backend (volume euidos-internal_db)
                     cloudflared `euidos.internal.tunnel` (unchanged throughout, up 4h+)
```

Same shape as `collab-plan.md`'s diagram; the boxes that materialized exactly as specified are the storage
service, the compose topology, and the identity-resolution order. Everything below this line is what changed
between "the plan" and "what shipped and passed review", because that is where the actual engineering happened.

## Deviations from the contract (every one, with why)

**Cross-builder mismatch, found and fixed at deploy:**
- The plan did not name the storage service's env vars; the storage builder's `config.js` reads
  `PG_HOST/PG_PORT/PG_NAME/PG_USER/PG_PASSWORD/MAX_FILE_BYTES`, while the infra builder's compose (following
  `internal-platform-notes.md §2`'s `<SERVICE>_PG_*` convention) fed `BOARDS_PG_*`/`FILE_UPLOAD_MAX_BYTES`. Left
  as specified, the service would have started with an empty Postgres password and failed the auth handshake on
  every request. Fixed at deploy by mapping the platform's names onto the service's names in compose's
  environment block (`stack.env` keeps `BOARDS_PG_*`, per platform convention; the container sees `PG_*`). The
  storage builder's unrelated `DATABASE_URL` alias was dropped — nothing reads it.

**Review-driven additions, applied before the phase-1 deploy went live (see EVIDENCE for the finding→fix pairs):**
- `PUT /api/rooms/:id` gained an optional `baseVersion`; the UPDATE is now conditioned on it (`AND version =
  $baseVersion`), answering 409 on a stale write instead of silently discarding the losing writer's elements.
  **Phase 2/3 must read this**: the client-side merge in `euidosStorage.ts` retries GET→reconcile→PUT up to 5
  times on 409 — any future write path to `/api/rooms/:id` needs the same retry, not last-writer-wins.
- `scenes.elements` moved from `jsonb` to `json` (migration `002_scene_elements_json.sql`, idempotent, applied at
  container start): Postgres `jsonb` rejects a literal NUL byte, `json` does not. `elementCount` moved from a
  computed `jsonb_array_length` to a stored `scenes.element_count` column written at save time (also fixes
  tombstoned/`isDeleted` elements inflating the count for 24h).
- `PUT /api/files/:id` no longer replays an arbitrary caller-supplied `Content-Type` verbatim: a small
  raster-image allowlist, everything else coerced to `application/octet-stream`; every file AND `#json=` blob
  response now carries `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`. Closes a stored-XSS path (see EVIDENCE — was reachable
  with zero credentials from any tailnet device against a logged-in Access session on `board.euidos.ai`).
- State-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`) are refused 403 when `Sec-Fetch-Site` is anything but
  same-origin/none, or when `Origin` is present and its host does not match the request host; JSON routes also
  require `Content-Type: application/json` (415 otherwise). Closes a CSRF gap that existed because tailnet
  identity is ambient (no cookie the browser could withhold).
- `via:"wall"` (the credential-free fallback for any tailnet device with no `Tailscale-User-Login`) can no longer
  `PATCH`/`DELETE` a board (403); it can still read and save the room it is displaying. Recovery for a
  soft-deleted board is `UPDATE boards SET deleted_at = NULL`, documented in the storage README, not a route.
- `/stt/` on both nginx blocks now blanks `Cookie`, `Authorization`, `Cf-Access-Jwt-Assertion`,
  `Cf-Access-Authenticated-User-Email`, `Tailscale-User-Login`/`-Name`, `X-Euidos-Listener` before proxying to
  the desktop STT box — it was forwarding every client header unscrubbed, leaking an Access session to a host
  outside this trust boundary. **Not narrowed** to the single transcription endpoint (deliberately — `/stt/health`
  is used by the deploy smoke check and the founder's own probes); flag this for phase 2 when the voice tool's
  actual STT call path is known.
- `add_header` does not inherit into a location that declares its own: the static-shell and asset locations were
  serving with no `X-Content-Type-Options`/`Referrer-Policy` even though the server block declared them. Fixed
  by repeating the two headers on the asset location and switching the shell location to `expires -1` instead of
  its own `add_header` (which had also produced two conflicting `Cache-Control` lines).
- `PUT /api/rooms/:id` no longer auto-creates an "Untitled" board for a `#room=` link that was opened and left
  idle with zero elements (only for one that actually got drawn into). The plan's phase-1 acceptance line "creates
  an 'Untitled' board row if none" still holds for the case that matters — a real first save — but the auto-create
  was also firing on every idle link-open, and 4 of 10 stray "Untitled" boards accumulated in this round's own
  testing had zero elements and an un-backfillable empty `roomKey`.
- Minor hardening, no contract impact: `HEAD` dispatched as `GET` (was 405); `decodeURIComponent` on every path
  id is guarded (was an unguarded 500 + stack trace to the log on a malformed id, now a clean 400); a 413 on
  `POST /api/v2/scenes` now carries `error_class: "RequestTooLargeError"` so the app's existing branch (written
  for the Firebase functions backend) shows "too big" instead of a generic link-creation failure.

**Not done, named and owned (see RETRO for gate numbers):**
- No app-wide Content-Security-Policy (Excalidraw's own inline styles/blob workers/data-URI images make a wrong
  policy live-break the board; the XSS primitive it would have been belt-and-braces for is closed at source on
  `/api/files` and `/api/v2/scenes` instead).
- No rate limiting / retention job for the unbounded blob and file store (behind cloudflared + Tailscale Serve
  every user shares one source IP, so `limit_req` would throttle the founder, not an attacker; headroom is 1.5T
  at 2% used). The empty-scene fix above stops the specific growth pattern observed this round.
- `/stt/` still proxies the whole prefix, not just the transcription endpoint.

## Contestable decisions (settled for phase 1)

- Fix the smaller side of the env-var mismatch (compose maps names onto the service) rather than renaming the
  service's own config — the service's names are internal to it and the platform convention lives in compose.
- Ship the review's MUST/SHOULD findings before calling phase 1 done, in the same round, rather than deferring
  them to a "phase 1.1" — the lost-update and stored-XSS findings are both reachable on day one with zero
  credentials from the tailnet, and both are cheap fixes relative to a second deploy round.
- Keep `whiteboard/` completely untouched and undeployed this round. Phase 2 owns the port; phase 1 proves the
  new backend and app plumbing hold up without voice in the picture at all.

## Phase 2 — voice tool port (as built)

Understood as: move the voice tool (0.1.0, `whiteboard/`) into `excalidraw-app/` so it runs against the
WORKSPACE Excalidraw packages (current master) instead of the wrapper's published `0.18.1`, and so its scene
mutations flow through the same collab/persistence path phase 1 built — with no upstream file rewritten and
`whiteboard/` retired once the port is proven. Binding: `euidos/docs/collab-plan.md` phase-2 section, phase-1's
`RETRO.local.md` G-P2.1–G-P2.5 gates, and `whiteboard/CLAUDE.md`/the 0.1.0 casebook as the tool's spec. Weight:
**full** — two builders in sequence (module port, then wiring+deploy prep), an adversarial review, a fix pass,
and a cold-run resume, all in this round.

## Thesis

The tool's own contracts (`contracts.ts`, `contracts-capture.ts`) do not change; only their host does. Every
voice module keeps its 0.1.0 name and file boundary under `excalidraw-app/voice/`. The one new file,
`VoiceTool.tsx`, is the wrapper's `src/App.tsx` wiring collapsed into a single component so the upstream diff
stays small: four touchpoints (`App.tsx`, `components/AppMainMenu.tsx`, `collab/Collab.tsx`, plus later
`data/euidosStorage.ts` for the retry-aware save) and zero new props threaded through `<Excalidraw>` — the
controller still self-subscribes via `api.onPointerDown/onPointerUp`, the settings panel reaches the menu
through the voice module's own store.

## What was built (as-built)

- `excalidraw-app/voice/` — 14 modules + `voice.css`, ported byte-faithful from `whiteboard/src/*` where API
  drift allowed (contracts, controller, fit, persist, capture, vad, stroke, assign, level, stt, settings,
  settings-panel, toolbar) — see "API drift" below for every place master would not compile against the
  0.18.1-shaped code. `VoiceTool.tsx` (245 lines) is the new wiring component; `voice/index.ts` is a barrel so
  upstream files import one path instead of two.
- `whiteboard/` deleted from the repo and disk (`git rm -r` + `rm -rf`); its Playwright suite moved to
  `euidos/e2e/voice/` (own `package.json`, pinned `@playwright/test` 1.63.0, fixtures moved, config rewritten
  to serve `excalidraw-app/build` via `vite preview`); its casebook moved to
  `euidos/casebook/iteration/0.1.0-voice-areas/` (git mv); its kiosk scripts moved to `euidos/scripts/kiosk/`
  with `deploy.sh` renamed `deploy-static.sh` and marked LEGACY — DO NOT RUN (it builds a `whiteboard/dist` that
  no longer exists); `copy-fonts.mjs` was **not** ported (see deviations).
- `sweepGhostPlaceholders` wired on both scene-load paths per G-P2.2: local/initial (`App.tsx initializeScene`
  and the `hashchange` re-init) and collab (`Collab.tsx`, right after `euidosStorage.loadFromFirebase`, before
  `_reconcileElements`) — deliberately not in the per-frame reconcile path, where a peer's live interim preview
  is intended behaviour.

## API drift absorbed by the port (master vs. the 0.18.1 the wrapper targeted)

- `@excalidraw/excalidraw/element/types` → `@excalidraw/element/types` (type-only).
- `@excalidraw/excalidraw/data/transform` → `@excalidraw/element/transform` (type-only).
- Value imports (`CaptureUpdateAction`, `newElementWith`, `ROUNDNESS`, `convertToExcalidrawElements`, the lazy
  `restoreElements`/`restoreAppState`/`restoreLibraryItems` import) deliberately kept on the `@excalidraw/excalidraw`
  barrel — it resolves to `packages/excalidraw/index.tsx` under the root tsconfig/vitest/vite aliases and keeps
  `vi.mock("@excalidraw/excalidraw")` doing what the 0.1.0 tests wrote it to do.
- `appState.currentItemStrokeWidth: number` is gone on master; replaced by `currentItemStrokeWidthKey` +
  `STROKE_WIDTH[key]` (from `@excalidraw/common`) in `controller.ts`'s `snapshotStyle` — no contract change,
  since every voice-drawn element is non-freedraw.
- `window.EXCALIDRAW_ASSET_PATH`'s wrapper-local narrower declaration was dropped (master's own
  `global.d.ts` conflicted with it; nothing in `voice/` read the wrapper's copy).
- **Toolbar DOM, the one drift no unit test can hold**: 0.18.1 rendered a tool as `label.ToolIcon` around a
  hidden `input[data-testid="toolbar-<type>"]`; master's `Tools.tsx` renders a single
  `button.ToolIcon[data-testid="toolbar-<type>"]`. `toolbar.tsx`'s DOM-matching and injected buttons were
  adapted; only the Playwright suite proves it (see EVIDENCE — 27/27 green against the real DOM).
- `points` on linear/freedraw elements are branded `LocalPoint` on master; only the `controller.test.ts` fixture
  needed `pointFrom<LocalPoint>` — production code was unaffected.
- The root vitest config is `jsdom` with a mandatory `setupFiles`, not the wrapper's `node` environment; jsdom's
  `Blob` lacks `arrayBuffer()`, fixed with a `blobBytes()` helper in `vad.test.ts` (3 gates), no production code
  affected.
- `copy-fonts.mjs`/`public/fonts` are obsolete: `excalidraw-app` already emits `build/fonts/` via its own
  `woff2BrowserPlugin` and sets `EXCALIDRAW_ASSET_PATH` in `index.html`; `fit.warmFonts()` needs no build step.

## Deviations from the phase-2 plan section, with why

- **`persist.ts` ships three exports the app must never call** (`createPersister`, `loadInitialData`,
  `libraryAdapter`) — vanilla-localStorage scaffolding the app already owns via `data/LocalData.ts` +
  `data/euidosStorage.ts`. Kept rather than deleted on the first pass because narrowing the module's own
  contract was judged a design decision, not a builder's convenience; flagged in `voice-tool-CLAUDE.md`'s Never
  list. Not resolved by the review/fix round either (see RETRO G-P2.10).
- **No env-gated kill switch at first wiring** — `<VoiceTool>` and the menu item mounted unconditionally,
  breaking the fork's own established pattern (`VITE_APP_ENABLE_PWA`, `VITE_APP_ENABLE_TRACKING`). Added in the
  review/fix pass: `excalidraw-app/voice/enabled.ts`, `isVoiceEnabled()` on `VITE_APP_ENABLE_VOICE`, fail-open.
- **`window.__excalidrawVoice` debug surface and the `100.81.33.83:8770` literal ship in every build**,
  including the hosted `board.euidos.ai` bundle — flagged by review, explicitly **skipped**: both e2e suites and
  the kiosk probes read the debug global, so gating it needs the same fail-open flag as the kill switch above
  plus new config threading through `deploy-whiteboard.sh` and two e2e configs, for a residual exposure (an
  internal tailnet IP, behind Access on the public origin) judged not worth that surface. Left for the founder.

## Review-driven fixes (see EVIDENCE for the finding→fix table; commit `c5624afc`)

- `persist.ts`'s sweep now performs a real versioned edit (`newElementWith(el, { isDeleted: true })`) instead of
  a shallow `{...el, isDeleted:true}` copy, so a swept tombstone bumps version/versionNonce/`updated` and can
  actually out-race a live peer's copy through `reconcileElements`'s tie-break and survive `DELETED_ELEMENT_TIMEOUT`.
  **This was the MUST finding**: the pre-fix sweep was a canvas-local cosmetic that never left the sweeping
  client's tab (see RETRO for the full mechanics).
- The sweep is now liveness-aware on the collab call site only (`SweepOptions.keepRecentMs`, default
  `LIVE_SCAFFOLDING_MS = 30_000`, judged per marker/placeholder GROUP via `element.updated` as a heartbeat) —
  the local/initial path still sweeps unconditionally, which is correct there (that browser is the only one
  that could have been mid-take before its own reload).
- `Collab.tsx`'s broadcast watermark (`lastBroadcastedOrReceivedSceneVersion`) is now taken from the PRE-sweep
  array, so the sweep counts as a local change and actually reaches the wire and the next save.
- `controller.dispose()` now runs the same load-path sweep over the live scene (CaptureUpdateAction.NEVER)
  before tearing down, so a clean React unmount leaves no litter. The tab-CLOSE case is **not** fixable: Collab
  registers its `beforeunload` handler in its own constructor, earlier than `VoiceTool`'s effect can run, and
  clones the scene synchronously there — no later listener can win. Documented as an invariant, not silently
  left.
- `fit.warmFonts()`'s memo is now keyed by font family (`Map<number, Promise<void>>`) instead of a single
  `??=` the first caller settled forever, so `controller.ts`'s per-take `await fit.warmFonts(style.fontFamily)`
  means what it says for any family other than the boot-time default.
- `euidosStorage.ts`'s `saveToFirebase` takes an optional `getLiveElements` reader called at the top of every
  409 retry (not just the first attempt), so a race can no longer persist a 45%-opacity interim preview as the
  stored state of words the author's canvas has already committed.
- Merge-surface cleanup: `voice/index.ts` barrel + a `VoiceSettingsMenuItem` export cut `AppMainMenu.tsx`'s
  insertion from +17 to +5 lines and `App.tsx`'s voice imports from two paths to one.
- `build-app.sh` now prints the entry bundle's raw and gzipped byte size, not just directory size, so future
  phases have a real regression baseline (first: 1,895,329 B raw / 611,233 B gzipped, +901 B over the pre-fix
  build).

## Not done, named and owned

- The tab-close scaffolding-litter path (above) — leans entirely on the load-path sweep, which is why the
  tombstone-bump fix is a release blocker rather than a cleanliness nicety.
- `persist.ts`'s three unused vanilla-storage exports — still shipped, still unwired, still a named decision
  for the founder (RETRO G-P2.10).
- The `window.__excalidrawVoice` / STT-host-literal exposure in every build — skipped with reasons above.
- A second ownership/session-liveness signal for the sweep (beyond the `updated` heartbeat) — `RETRO` G-P2.9
  names the residual risk (a live peer's take can still be destroyed if it goes silent for 30s+, e.g. mid-utterance
  while another peer's join sweeps).

## Contestable decisions (settled for phase 2)

- Fix the sweep's timestamp-based liveness with the cheapest signal already in hand (`element.updated` as a
  heartbeat) rather than adding a new `customData.voiceSession` protocol field — cheaper, no schema/version
  bump, and the controller already rewrites the placeholder ~3x/s and the interim on every slice, so the
  heartbeat is real.
- Ship the review's MUST/SHOULD fixes in the same round rather than deferring to a "phase 2.1" — same reasoning
  as phase 1: the tombstone-resurrection defect is reachable the first time two peers share a room with the
  voice tool on, and the fix is cheap relative to a second review round.
- Do not attempt the deploy from an agent session once the permission classifier refused it twice — the
  founder's own no-workaround rule applies to deploys as much as to any other disruptive host action (see RETRO).

## Phase 3 — boards page and identity (as built)

Two builder rounds: a build round that shipped the page against the phase-1/2 contract, then a hate-stance
adversarial review that found 18 findings (2 MUST, 8 SHOULD, 6 NICE, plus 2 pure security/merge-surface findings
folded in) against the LIVE rehearsal stack, followed by a fix round that applied 20 of the fixes and named the
2 it deliberately skipped. Both rounds ran against a throwaway rehearsal of the real
`fleet-infra/stacks/euidos-internal` compose (nginx + storage + postgres + room relay) under project name
`boards-e2e`, published on `127.0.0.1:18099` only, never on `0.0.0.0` — the same "rehearse before touching the
host" discipline phase 1's deploy stage established. Neither round touched `euidos-internal` or the wall kiosk;
nothing here is deployed or pushed.

## Thesis

The boards page is a new, self-contained module (`excalidraw-app/boards/`) mounted from three one-line
insertions in upstream files (`App.tsx`, `AppMainMenu.tsx`, `Collab.tsx`), exactly the "mount line, not a
rewrite" pattern phase 2 used for the voice tool. It renders at `/boards` and at the bare origin `/`;
`#room=`, `#json=`, `#local` and `#addLibrary=` all still resolve to the editor, so the pre-existing local
scratch board stays reachable at `/#local`. The collaborator name shown to peers stops being a random
adjective-noun pair and becomes the edge identity (`/api/me` login, or "Wall") — the identity the backend
already stamps per phase-1's `via` order, now surfaced in the UI rather than only enforced server-side.

## What was built (as-built)

- `boards/api.ts` — a typed client over `/api/boards` and `/api/rooms`; every request is same-origin, JSON
  content-type only when there is a body, ids percent-encoded into the path; errors map by status (401 → the
  same `EuidosSessionError` the rest of the app recognizes via `isSessionError`, 403 → a distinct
  `BoardsForbiddenError` that is explicitly NOT a session error so it doesn't trigger a reload prompt, 404/409/413
  typed, a rejected fetch itself treated as a session error).
- `boards/identity.ts` — one shared `/api/me` fetch per page load, cached, NOT cached on failure (so a
  transient 401 doesn't wedge every caller); `via` values other than `"access"`/`"tailnet"` normalize to
  `"wall"` (fail-closed for `canManageBoards`); the wall's display name is a fixed `"Wall"`.
- `boards/route.ts` — the pure routing predicate (list vs. editor) and `hasLink()`, the gate behind G-P3.2's
  "no broken link" requirement.
- `boards/format.ts` — relative-time buckets ("3 min ago", "just now" for future clock-skew, "unknown" for
  unparseable dates) and singularization for the "by X, N elements" line.
- `boards/BoardsPage.tsx` — the list (newest-edit-first, per the backend's own ordering), create (name →
  `generateCollaborationLinkData()` → `POST` → open), open, copy link, inline rename, delete behind a confirm
  dialog, loading/empty/error states; keyboard-driveable; light+dark via upstream's own CSS variables
  (`--color-primary`, `--island-bg-color`, etc.), no new design tokens introduced.
- `boards/BoardsRoute.tsx` / `BoardsMenuItem.tsx` / `boards/index.ts` — the three upstream-facing seams, kept to
  one import + one JSX element each in `App.tsx`/`AppMainMenu.tsx`. `Collab.tsx`'s seam is a leaf import
  (`../boards/identity`, not the barrel) so the collab module does not drag the boards React tree/CSS into its
  own dependency graph.
- G-P2.10 housekeeping (decided by the main loop, not re-litigated here): `persist.ts` lost
  `createPersister` / `loadInitialData` / `libraryAdapter` and everything that existed only to support them
  (453 → 205 lines); `sweepGhostPlaceholders` and both its test files are untouched.

## Review-driven fixes (fix round; see EVIDENCE for the finding→fix table)

- **MUST — browser Back out of a live board no longer discards unsaved drawing.** `boards/leave.ts` is a new
  scene-flush registry: `Collab.tsx` registers a flush function while mounted and unregisters it on unmount;
  `BoardsRoute` detects the editor→boards direction and calls `leaveEditorForBoards()` (flush, then a REAL
  navigation via `window.location.reload()`, which also closes the socket) instead of swapping React trees in
  place. Root cause was a listener-ordering race: BoardsRoute's hashchange listener ran before App.tsx's own
  (which only registers once `excalidrawAPI`/`collabAPI` exist), so React unmounted the editor before
  `Collab.componentWillUnmount` — which neither saves nor calls `destroySocketClient` — could flush the pending
  20 s save throttle.
- **MUST — a `roomKey: ""` board (G-P3.2) no longer has ANY open affordance, not just no copy-link.** Previously
  only "Copy link" was gated on `hasLink()`; the name button and "Open" still navigated to `#room=<id>,` (empty
  key), which upstream's `getCollaborationLinkData` silently treats as no room and falls through to the
  browser's OWN localStorage scratch scene — a private board rendered under someone else's name with no signal
  anything was wrong. All three affordances (name, Open, Copy) now share one `hasLink()` gate; an unopenable row
  reads "cannot be opened — no room key stored".
- **SHOULD — the in-app "Boards" menu item flushes before navigating** instead of relying on `beforeunload`
  (which only closes the socket, never saves, and pops the browser's own "Leave site?" prompt); `gotoBoards()` is
  now async and shows a "Saving…" state first.
- **SHOULD — the list refetches on focus/visibilitychange** plus a manual Refresh button, so a second person's
  edit or delete does not sit invisible in a tab left open; a failed refresh never blanks an already-usable list.
- **SHOULD — session-expired state now offers a working "Reload" action** (`window.location.reload()`) instead
  of a "Try again" that can never succeed against a cross-origin Access login redirect a `fetch()` cannot follow.
- **SHOULD — every request now times out** (`AbortSignal.timeout`, 15 s) and maps to a retryable
  `BoardsTimeoutError`; "New board" is no longer disabled purely because the list is still loading.
- **SHOULD — the delete confirm dialog is now a real keyboard modal**: Tab is trapped inside, Escape works from
  a capture-phase document listener regardless of focus, backdrop mousedown closes it, focus returns to the
  control that opened it.
- **SHOULD — secondary row buttons (Open/Copy/Rename) get a real surface in light theme** — they previously
  painted `#fff` on a `#ffffff` row with a transparent border and read as plain text; now
  `--color-surface-high` + `--default-border-color` in both themes.
- **SHOULD — a save into a deleted board names the cause.** `euidosStorage.ts` now raises a specific
  `BoardDeletedError` on a `PUT /api/rooms` 404, so the editor's dialog says "this board was deleted" instead of
  upstream's generic "Couldn't save to the backend database".
- **SHOULD — board names are real anchors** (`<a href={boardLink}>`), so ctrl-click / middle-click / "copy link
  address" work; the redundant "Open" button is gone.
- **SHOULD — `applyEdgeIdentity` moved out of `Collab.tsx` into `boards/identity.ts`** as
  `resolveCollaboratorName(currentUsername)`; the upstream file keeps one call, not a 28-line private method —
  restoring the "mount line, not a rewrite" bar the review held phase 2 to as well.
- **SHOULD — the "Your name" field in `ShareDialog` is read-only once an edge identity resolves**
  (`boards/CollaboratorNameField.tsx`), closing the gap where the UI called the collaborator name "the edge
  identity" while an upstream text field could still overwrite it to impersonate anyone after joining.
- **SHOULD — `hasLink()` now enforces the LINK PARSER's rule, not the backend's.** The backend's
  `ROOM_KEY_RE` accepts a wider alphabet and length range than upstream's `RE_COLLAB_LINK` /
  `getCollaborationLinkData` (which further requires an exact 22-char key) — `hasLink()` was only checking
  non-empty, so a key the backend would store but the app cannot parse rendered an enabled, silently-broken
  Copy link.
- **SHOULD — the wall's G-P3.1 403 is now asserted at the security layer**, not only as hidden buttons: the
  e2e sends a header-less PATCH and DELETE with an explicit `Origin` and asserts 403 from the backend itself.
- **SHOULD — `voice-tool-CLAUDE.md`'s spec and never-list no longer assert something false about the code**:
  the three stale references to `createPersister`/`loadInitialData`/`libraryAdapter` as live exports are now
  past tense, closing the "open decision" the never-list had carried since G-P2.10 landed.
- **NICE fixes**: `displayNameFor()` returns "Wall" only for an identity the backend actually resolved as the
  wall (not any unrecognized `via`, which now reads "Unknown"); `BoardsRoute`'s test short-circuit is now an
  overridable prop, closing the unit-test coverage gap on the route rule itself; an emptied rename now says so
  and keeps the field open instead of discarding silently, and notices get a dismiss control; `document.title`
  is "Boards — euidos" while the index is mounted; a client-side filter (name + updatedBy) appears once there
  is more than one board.

## Not done, named and owned

- **The phase-1 RETRO L3 gate is still unmet.** Delete ships without a `/restore` route or admin view; the
  storage backend is outside every phase-3 builder's file scope. Mitigation is the confirm dialog's own text
  (recovery needs a database edit; no undo) plus, after the fix round, a clearer message when a save lands on a
  deleted board — neither is a substitute for the route the RETRO asked for.
- **The wall's "New board" button is left in place, on purpose.** Hiding it was flagged as a possible fix but
  explicitly NOT applied: `POST /api/boards` has no `requireNamedIdentity`, and the rows it creates are
  deletable by ANY signed-in person (delete is gated on `via !== "wall"`, not on ownership) — the stated harm
  ("only a signed-in person can remove it") does not hold up, and a meeting at the wall starting a board is a
  legitimate use. Left for the founder to decide, not decided here.
- **No larger type scale for the wall's 1920x1080 viewport.** The kiosk opens a board directly today, not the
  index, and the deferred cutover (see collab-plan.md "what is left") is the point at which the index's layout
  at kiosk scale would actually matter.
- **nginx's `$host`/`$http_host` CSRF fragility, found and reproduced live, is explicitly not fixed here** —
  `fleet-infra/stacks/euidos-internal/nginx.conf` is outside this task's file scope. `proxy_set_header Host
  $host;` drops the port, so any origin with a non-default port (like the rehearsal's `127.0.0.1:18099`) 403s
  its own same-origin writes because the backend compares a portless `Host` against a ported `Origin`.
  Production is unaffected today (both front doors are on 443, so `Origin` carries no port either) but the
  mismatch is real and one word (`$http_host`) away from closed. `euidos/e2e/boards/rehearsal.sh` patches a
  COPY of the config for its own throwaway stack and documents why at the top of the script; the real file was
  never touched.

## Contestable decisions (settled for phase 3)

- Fix the Back-button data-loss bug with a real navigation (reload) rather than a more surgical in-place
  teardown-then-remount — a reload is slower by a beat but cannot race listener ordering the way the original
  hashchange-only approach did, and it is the same mechanism a closed tab already uses.
- Keep the wall's "New board" button rather than hiding it pending a founder call — the review's own stated
  harm didn't survive a second look once delete's actual authorization rule (`via !== "wall"`, not ownership)
  was checked, so removing a legitimate use case to guard against a harm that doesn't exist was rejected.
- Tighten `hasLink()` to the LINK PARSER's rule instead of loosening the backend's `ROOM_KEY_RE` to match it —
  the app-side fix is one line and needs no schema/deploy change; narrowing the backend is deferred (noted, not
  done, since storage-backend is out of scope this round).
