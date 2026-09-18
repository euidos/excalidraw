# Collaborative boards — plan (approved 2026-09-18)

Founder's goal, verbatim: "an Excalidraw collaboration room, where multiple
people can collaborate on a single board on a host, the board saves to the
server in real time, you can share it, and you can create new boards, pull
them up later, and edit them on the web."

Decisions taken (all approved):

1. **The voice tool moves into `excalidraw-app/`** (this fork's app, which has
   collaboration built in). `whiteboard/` (the wrapper on the published
   package) is retired when the port lands; its history stays in git.
2. **Boards are stored by our own service** (`euidos/storage-backend`, Node 22
   + PostgreSQL) on euidos-internal, replacing Firebase.
3. **Boards are server-readable.** Staff login (Cloudflare Access → Authentik)
   is the privacy boundary; the per-room key still encrypts the socket relay
   because that code is untouched, and the key is stored with the board.
4. **Identity comes from the edge**: Access JWT on `board.euidos.ai`,
   Tailscale Serve headers on the tailnet name; the wall is the anonymous
   "wall". Collaborator name and "created by" are the login email.
5. **A board = a row in an index** (name, creator, last edit) with open / copy
   link / rename / delete. All boards visible to all staff. **No "show on
   wall"** (deferred by the founder), no per-board permissions, no external
   sharing (Access blocks it).

Also deferred, needs the founder's go: cutting the wall kiosk over from its
local static build to the hosted app, and importing today's wall board as
board number one. Until then the kiosk keeps running `whiteboard/` round 5.

Platform constraints for everything below: `fleet-infra/docs/internal-platform-notes.md`.

## Architecture

```
browser (staff)  ──https──▶ Cloudflare edge ──Access──▶ tunnel euidos-board ─┐
wall / tailnet   ──https──▶ Tailscale Serve (euidos-internal.…ts.net:443) ───┤
                                                                            ▼
                     nginx `euidos.internal`  (two server blocks: :80 tunnel, :8081 tailnet)
                       /            static app build (excalidraw-app/build)
                       /api/        storage backend  (euidos/storage-backend, :3000)
                       /socket.io/  excalidraw-room  (relay only, no persistence)
                       /stt/        desktop STT (100.81.33.83:8770)
                     postgres:16 `db`  ◀── storage backend
```

One static build serves both origins: the app derives the API base and the
socket URL from `location.origin` at runtime (no baked hostnames).

## Storage API (contract both builders follow)

All routes except `/api/health` require an identity (see below). JSON unless
noted. Errors: `{error, message}` with 4xx/5xx.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | `{ok:true, db:"ok"}` — no auth; `503 {ok:false, db:"error"}` when Postgres is unreachable |
| `GET /api/me` | `{login, name, via:"access"\|"tailnet"\|"wall"}` |
| `GET /api/boards` | `{boards:[{id,name,roomKey,createdBy,createdAt,updatedBy,updatedAt,elementCount}]}` (not deleted, newest edit first); `elementCount` is a stored column (live, non-tombstoned elements), written on every save |
| `POST /api/boards` `{id,roomKey,name}` | client generates `id`+`roomKey` with the app's `generateCollaborationLinkData()`; 201 board; 409 if id exists |
| `PATCH /api/boards/:id` `{name}` | rename; **`via:"wall"` → 403** (phase-1 review fix; wall can still read/save the room it displays) |
| `DELETE /api/boards/:id` | soft delete (`deleted_at`), 204; **`via:"wall"` → 403**; recovery is `UPDATE boards SET deleted_at = NULL` on the host — no restore route yet (phase 3 should add one before shipping delete in the UI) |
| `GET /api/rooms/:id` | `{elements, version, updatedAt}`; 404 if never saved |
| `PUT /api/rooms/:id` `{elements, baseVersion?}` | full-scene save (≤ 20 MiB); **optional `baseVersion`, checked with `AND version = $baseVersion`, answers 409 on a stale write** (phase-1 review fix for a lost-update race — the client retries GET→reconcile→PUT up to 5× on 409); creates an "Untitled" board row only when the elements are non-empty (an idle `#room=` link with nothing drawn no longer creates a row); returns `{version, updatedAt}` |
| `GET /api/files/:id` | raw bytes; `Content-Type` is coerced to a small raster-image allowlist or `application/octet-stream` (phase-1 fix — a replayed caller-supplied type was a stored-XSS path), always with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`; 404 |
| `PUT /api/files/:id?board=<id>` | raw bytes ≤ 4 MiB (`FILE_UPLOAD_MAX_BYTES`), 201 |
| `POST /api/v2/scenes` → `{id}`, `GET /api/v2/scenes/:id` → bytes | opaque blobs for `#json=` share links (upstream `exportToBackend`); same content-type/CSP hardening as files; a 413 carries `error_class: "RequestTooLargeError"` so the app's existing "too big" branch fires |

State-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`) are rejected 403 when `Sec-Fetch-Site` is cross-site, or
`Origin` is present and does not match the request host (CSRF guard — tailnet identity is ambient, carried by no
cookie a browser could withhold); the JSON routes also require `Content-Type: application/json` (415 otherwise).
A plain `fetch()` from the app already satisfies both; a cross-origin dev harness will not.

Tables: `boards(id text pk, name, room_key, created_by, created_at, updated_by, updated_at, deleted_at)`,
`scenes(board_id pk → boards, elements json, version int, updated_at, element_count int)` — **`elements` is
`json`, not `jsonb`** (phase-1 fix, migration `002`: `jsonb` rejects a literal NUL byte in text content, `json`
does not) —, `files(id text pk, board_id, content_type, bytes bytea, created_at)`,
`blobs(id text pk, bytes bytea, created_at)`, `schema_migrations`. Migrations are
SQL files applied at start-up, idempotent.

Identity resolution in the backend, in this order:
1. `Cf-Access-Jwt-Assertion` present → verify signature (JWKS
   `https://euidos.cloudflareaccess.com/cdn-cgi/access/certs`, cached), `aud`
   must equal `ACCESS_AUD` (env), `iss` the team domain → `via:"access"`, login
   = `email` claim.
2. else `X-Euidos-Listener: tailnet` (set by nginx's :8081 block only; nginx
   strips client copies on both blocks) → `Tailscale-User-Login` if present →
   `via:"tailnet"`; absent (tagged device) → `via:"wall"`, login `wall`.
3. else 401.

## Phase 1 — infrastructure and persistence (no voice, no boards page)

**Status: shipped and deployed** (2026-09-18; fork `master` @ `cff7269f`, fleet-infra `main` @ `dd22793`, both
committed and NOT pushed). Acceptance below passed 3/3 live against the tailnet origin; a security/correctness
review found 2 MUST and 4 SHOULD defects, all fixed and redeployed before this status line was written. Full
detail: `euidos/casebook/iteration/0.2.0-collab/{DESIGN,EVIDENCE,RETRO}.local.md`. Still open, needs the founder
(not an agent): confirm `via:"tailnet"` from an untagged personal device at
`https://euidos-internal.pony-bellatrix.ts.net/api/me`, and `via:"access"` after a real login at
`https://board.euidos.ai/api/me` — both are proven only up to the edge from agent-accessible boxes.

1. `euidos/storage-backend/`: service + migrations + Dockerfile + tests
   (integration tests against a throwaway Postgres container on dev-woo).
2. `excalidraw-app/`: `data/euidosStorage.ts` exporting the same names as
   `data/firebase.ts` (`isSavedToFirebase`, `saveToFirebase`, `loadFromFirebase`,
   `saveFilesToFirebase`, `loadFilesFromFirebase`), plaintext JSON over `/api`;
   `Collab.tsx` imports it; socket URL and API base from `location.origin`;
   `.env.production` trimmed (no Firebase, no tracking, no Plus promos, `#json`
   links → `/api/v2/scenes`); build via `corepack enable` + `yarn install
   --frozen-lockfile` + `yarn build:app` → `excalidraw-app/build/`.
3. `fleet-infra/stacks/euidos-internal`: compose gains `db`, `storage`, `room`;
   nginx gets the two server blocks and the three proxied paths; Serve maps
   `127.0.0.1:18090 → web:8081`; the tunnel keeps `web:80`; deploy script
   builds the app from the fork, ships the build + the storage image
   (`docker save | ssh docker load`), migrates, recreates.
4. Acceptance, from dev-woo against the tailnet origin: two Playwright
   browsers in one `#room=` link — a shape drawn in A appears in B within 2 s;
   both closed and reopened → the shape is still there (loaded from
   `/api/rooms`); `GET /api/boards` lists it; the public origin answers 302 →
   Access for `/`, `/api/boards` and `/socket.io/`; `/api/health` ok via both.

## Phase 2 — voice tool port — MERGED TO MASTER, NOT DEPLOYED (2026-09-18), acceptance 5 pending

Code-complete and reviewed on `master` (six unpushed commits ending `c5624afc`); `euidos-internal` still serves
the phase-1 build (`cff7269f`, no voice) as of this writing — the deploy has not run. What landed, as facts for
phase 3 and for anyone reading this plan later:

1. The tool is `excalidraw-app/voice/` — the 14 modules and `voice.css` under
   their 0.1.0 names, plus `VoiceTool.tsx` (the wrapper's `src/App.tsx` wiring
   as one component). Upstream touchpoints are four and no more:
   `App.tsx` renders `<VoiceTool excalidrawAPI={…} />` and sweeps the local
   scene, `components/AppMainMenu.tsx` carries the "Voice settings…" item,
   `collab/Collab.tsx` sweeps the room scene. No new prop threads through the
   editor: the menu reaches the panel through the voice module's own store, and
   the controller subscribes its own pointer handlers via
   `api.onPointerDown/onPointerUp`.
2. `sweepGhostPlaceholders` runs on BOTH load paths (G-P2.2): the local/initial
   scene in `App.tsx initializeScene` (and on `hashchange` re-init), and the
   collab scene in `Collab.initializeRoom`, right after
   `euidosStorage.loadFromFirebase` and before reconcile. Deliberately NOT in
   `_reconcileElements`: a peer seeing someone else's live interim preview is
   acceptable, a persisted ghost is not. Covered by
   `voice/__tests__/collab-sweep.test.ts`.
3. Tests: 194 unit under the root vitest (`yarn vitest run excalidraw-app/voice`,
   jsdom — 174 at first port, +5 for the collab sweep, +15 from the review/fix
   round below); the 27 Playwright gates moved to `euidos/e2e/voice/` and run
   against the BUILD (`vite preview` of `excalidraw-app/build` on
   `127.0.0.1:4173`) plus the real STT — 27/27 green, no flakes, across four
   independent runs including a same-day cold-run resume. R5a pen-up → words
   **83–89 ms** (gate ≤ 400 ms), STT round trip 1.5–1.6 s.
4. Kiosk scripts are `euidos/scripts/kiosk/`; `deploy.sh` became
   `deploy-static.sh` and is LEGACY (the wall still serves its own pre-port
   static build and is frozen until the founder approves the cutover — do not
   deploy to it, reload it or relaunch it). `copy-fonts.mjs` was NOT ported: the
   app has its own woff2 pipeline and sets `EXCALIDRAW_ASSET_PATH` itself. The
   casebook is `euidos/casebook/iteration/0.1.0-voice-areas/`, the spec
   `euidos/docs/voice-tool-CLAUDE.md`, the runbook
   `euidos/docs/voice-tool-README.md`. `whiteboard/` is deleted.
5. STT (G-P2.4): the loopback/else rule in `contracts.defaultSttUrl` is
   unchanged, so the e2e (127.0.0.1) exercises the DIRECT URL. The proxied
   branch was measured, not assumed: a real multipart
   `POST https://euidos-internal.pony-bellatrix.ts.net/stt/v1/audio/transcriptions`
   with a fixture WAV answered **200 in 1.82 s** with the correct transcript,
   `/stt/health` warm — nginx's identity-header stripping is transparent to the
   upload.
6. A review found 2 MUST + 5 SHOULD + 6 NICE findings against the wiring, most
   severe: `persist.ts`'s ghost-placeholder sweep tombstoned without bumping
   version/versionNonce, so the deletion never won reconciliation against a
   live peer and never even left the sweeping client's own tab — fixed in
   `c5624afc` (`newElementWith`, liveness-aware on the collab call site via a
   30 s `element.updated` heartbeat). 11 of 13 findings fixed, 1 skipped and
   reasoned (the `window.__excalidrawVoice` debug global and the STT host
   literal ship in every build, including the hosted one — narrowing it needs
   new config threading both e2e suites depend on; left for the founder), 1
   turned out not to apply (a named scratch test file did not exist in the
   tree). Casebook: `euidos/casebook/iteration/0.2.0-collab/` phase-2 sections.
7. **Deploy blocked, not attempted around.** `deploy-whiteboard.sh master` was
   refused twice by the Claude Code auto-mode permission classifier under
   `[Production Deploy]`; per the founder's own rule, no agent decomposed the
   script into its ssh/scp/docker-load legs to route around the gate. A
   same-day cold-run resume proved the build and storage image both build
   green from `master` and re-ran the full unit+e2e suite against a fresh
   worktree, but its own `live-smoke.mjs` run against the real tailnet origin
   failed (times out waiting for `window.__excalidrawVoice` — the served
   bundle has zero occurrences of "voice"), confirming the host is still on
   phase 1 alone. Someone with deploy permission must run
   `bash fleet-infra/scripts/deploy-whiteboard.sh master` before acceptance
   step 5 or the two-peer collab-smoke re-run can proceed.
8. Still open: acceptance step 5 — the hosted app on the tailnet origin
   transcribing through `/stt` with the fake mic against the LIVE host (deploy's
   job, not the builder's), and 0.1.0's own open rows N13/N17/N18/N20/N21, which
   moved with the casebook (now at
   `euidos/casebook/iteration/0.1.0-voice-areas/`) and are NOT closed by this
   phase (G-P2.5).

## Phase 3 — boards page and identity — SHIPPED TO MASTER, NOT DEPLOYED (2026-09-18), two founder gates open

Code-complete and reviewed on `master` (4 unpushed commits: `952426e8`, `e2d2dcfa` build round;
`3fb2a719`, `2eea29a7` review-fix round). `euidos-internal` still serves the phase-2 build — the deploy has not
run. What landed, as facts for phase 4 and anyone reading this plan later:

1. `excalidraw-app/boards/` is a new, self-contained module: a typed storage-API client, cached edge identity,
   a pure route rule, and the boards page itself. It renders at `/boards` and at the bare origin `/`;
   `#room=`, `#json=`, `#local` and `#addLibrary=` all still resolve to the editor, so the pre-existing local
   scratch board stays reachable at `/#local`. Upstream cost is one import + one JSX element each in
   `App.tsx`, `AppMainMenu.tsx` and `Collab.tsx` — the same "mount line, not a rewrite" bar phase 2 held for
   the voice tool.
2. The list is newest-edit-first from the backend's own ordering; create (name → `generateCollaborationLinkData()`
   → `POST` → open), open (name is a real anchor, not a button), copy link, inline rename, delete behind a
   real keyboard-trapped confirm dialog. Light+dark via upstream's own CSS variables, no new tokens.
3. The collaborator name shown to peers is the edge identity (`/api/me` login, or "Wall") instead of a random
   adjective-noun pair; the free-text "Your name" field in `ShareDialog` is read-only once an identity resolves,
   so it can no longer be used to impersonate someone after joining.
4. Founder's phase-3 decisions are honoured as written: all boards visible to all staff, no per-board
   permissions, no external sharing, no "show on wall". G-P3.1 (wall gets 403 on write) is expressed by hiding
   those controls for `via:"wall"` AND, after the fix round, asserted at the security layer in e2e (a
   header-less PATCH/DELETE with an explicit `Origin` gets a real 403, not just hidden buttons). G-P3.2
   (`roomKey:""` never hands out a broken link) covers ALL open affordances after the fix round (name, Open,
   Copy), not only Copy as first shipped. G-P3.3 (`elementCount` stays the backend's) and G-P3.4 (same-origin +
   `Content-Type: application/json` on every write) hold as designed.
5. A hate-stance review against the LIVE build round found 18 findings (2 MUST — Back-button data loss,
   the `roomKey:""` open-affordance gap — plus SHOULD/NICE); a fix round applied 20 of 22 applicable fixes.
   Two are deliberately NOT applied: the wall keeps its "New board" button (the review's stated harm didn't
   survive a check of the actual delete rule, which is `via !== "wall"`, not ownership — see RETRO L8), and
   the phase-1 RETRO L3 gate (`/restore` route or admin view before delete ships) is STILL open — storage-backend
   is out of every phase-3 builder's scope. Full detail: `euidos/casebook/iteration/0.2.0-collab/{DESIGN,
   EVIDENCE,RETRO}.local.md`.
6. Tests: 297 unit (`yarn vitest run excalidraw-app`, was 251 pre-phase-3, +46 across the review-fix round);
   `euidos/e2e/boards` 11/11 green (was 8) against a throwaway rehearsal of the real
   `fleet-infra/stacks/euidos-internal` compose, published on `127.0.0.1:18099` only, torn down with `-v` every
   time; `collab-smoke.mjs` and the full 27-gate voice suite both re-confirmed green on the same build.
7. Real infra finding, out of scope to fix here: nginx's `proxy_set_header Host $host;` drops the port, so any
   non-443 origin (like the rehearsal's own `127.0.0.1:18099`) 403s its own same-origin writes against
   phase-1's CSRF guard — production is unaffected (both front doors are on 443). One word (`$http_host`) from
   closed; `fleet-infra/stacks/euidos-internal/nginx.conf` is not a phase-3 file.
8. Deploy not attempted (out of this task's scope, per instruction — the main loop deploys after this round,
   same discipline as phase 2's deploy gate).

## What is left

**Blocking phase 4 planning, needs the founder (not another build round):**

- **Wall cutover.** The kiosk (`100.102.3.47`) currently opens a bare origin, which is now the boards INDEX,
  not a board — after cutover its URL must carry a `#room=` (or click through from the index), or the wall
  displays a list instead of a canvas. Nothing has been changed on the kiosk; it has not been contacted by any
  agent in this iteration.
- **Board import.** The wall's existing local-static board (still on `whiteboard/` round 5) has no import path
  into the new storage backend. A one-off script or an admin route needs to turn that board into a normal row
  before or during cutover, and needs to decide what "created by" / "updated by" means for a board nobody in
  the new identity model actually authored.
- **The two identity branches (G-P3.5 / G-P3.9), open across all three phases of this iteration.** `via:"tailnet"`
  from the founder's own untagged device at `https://euidos-internal.pony-bellatrix.ts.net/api/me`, and
  `via:"access"` after a real login at `https://board.euidos.ai/api/me`, are both still proven only up to the
  header-forgery level — no non-interactive agent session can mint a real Access JWT or run from an untagged
  device. This is the 2-minute founder check below, not a task to route around with more agent-side header
  injection.
- **The phase-1 RETRO L3 restore gate**, now three memos old: either a `/restore` route / admin view lands
  before staff rely on delete, or the founder explicitly accepts the confirm dialog's honesty (no undo, needs a
  database edit) as sufficient.

**Deferred features, not blocking, no owner yet:**

- The `nginx $host`/`Origin` port-mismatch fix in `fleet-infra/stacks/euidos-internal/nginx.conf` (one word,
  `$http_host`) — only matters for non-443 rehearsals/QA, not production, but will bite the next ephemeral
  environment that isn't on port 443.
- A `TRUNCATE`/reset step in `euidos/e2e/boards/rehearsal.sh` so the boards e2e suite can be re-run against a
  live stack without a fresh volume — currently a false failure on the second consecutive run (RETRO G-P3.6).
- Wall-created boards multiplying without an ownership-aware cleanup story once board import happens (RETRO
  G-P3.10) — the current delete rule is identity-blind (`via !== "wall"`), not ownership-aware, which is fine
  at today's scale and may not stay fine after import.
- A larger type scale for the boards index at the wall's 1920x1080 viewport — deferred until the kiosk actually
  opens the index (today it opens a board directly).
- 0.1.0's own still-open rows (N13 kiosk real-mic re-measure, N17 native multi-point line conversion, N18 VAD
  noise-floor seeding, N20 bound interim preview growth, N21 unreproduced toolbar-latch flake) — untouched by
  phases 2 or 3, most blocked on the wall cutover itself (N13 specifically needs the kiosk's real microphone).

## Founder test — 2-minute walkthrough on `https://board.euidos.ai`

Do this in a normal browser tab, signed in through Cloudflare Access as usual.

1. Open `https://board.euidos.ai`. **Expect**: a list titled "Boards", not the drawing canvas — your name
   (your email) shown as the signed-in identity, and a "New board" button.
2. Click "New board", type a name, confirm. **Expect**: it opens straight into a blank canvas; draw one shape.
3. Send the same board to a colleague — copy the link (button on the boards list, or from the share dialog in
   the editor) and have them open it on their own machine, signed in as themselves. **Expect**: their cursor
   name is THEIR login, not a random word; your shape is visible to them within a couple seconds; anything they
   draw appears on your screen too.
4. Go back to the boards list (main menu → "Boards", or Back). **Expect**: your drawing is still there when you
   reopen it — nothing you drew a moment ago should vanish. The list should show this board at the top, with a
   "last edited by <colleague>" line if they drew something after you.
5. Rename the board from the list (inline rename, no dialog). **Expect**: the name changes immediately; the
   board does NOT jump to the top of the list just from a rename (only actual edits should reorder it).
6. Delete the board (delete button → confirm). **Expect**: a plain-language warning that this cannot be undone
   without a database edit — read it, it is accurate, there is no restore button yet. After confirming, the
   board disappears from your list; the old link, if you still have it, should open to an empty canvas rather
   than an error page.

**Two identity checks** (open each in a browser, no special steps):

- `https://board.euidos.ai/api/me` — should answer `{"login":"<your email>","name":"<your name>","via":"access"}`.
- `https://euidos-internal.pony-bellatrix.ts.net/api/me` from your OWN (untagged) device on the tailnet —
  should answer `{"login":"<your email>","name":"<your name>","via":"tailnet"}`, NOT `via:"wall"`. If it says
  `"wall"`, your device is reading as an anonymous tailnet node rather than you personally — worth reporting
  back, this is exactly the gate no agent could close.

Phase order is strict; each phase ends with a review, a fix pass, a clean-tree
cold run, and a casebook memo before the next starts.
