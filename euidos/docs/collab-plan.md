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

## Phase 3 — boards page and identity

1. `/boards` route (and the root when no `#room`/`#json` is present): list from
   `GET /api/boards`, create (name prompt → `generateCollaborationLinkData()` →
   `POST` → open), rename, delete with confirm, copy link. Plain React inside
   the app, styled with its variables.
2. Collaborator name = `/api/me` login (overrides the free-text username);
   `updatedBy` recorded on every save.
3. Acceptance: two users (two Playwright contexts with different identity
   headers via the tailnet origin) create/open/rename/delete; the list orders
   by last edit; a deleted board's link 404s.

Phase order is strict; each phase ends with a review, a fix pass, a clean-tree
cold run, and a casebook memo before the next starts.
