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
| `GET /api/health` | `{ok:true, db:"ok"}` — no auth |
| `GET /api/me` | `{login, name, via:"access"\|"tailnet"\|"wall"}` |
| `GET /api/boards` | `{boards:[{id,name,roomKey,createdBy,createdAt,updatedBy,updatedAt,elementCount}]}` (not deleted, newest edit first) |
| `POST /api/boards` `{id,roomKey,name}` | client generates `id`+`roomKey` with the app's `generateCollaborationLinkData()`; 201 board; 409 if id exists |
| `PATCH /api/boards/:id` `{name}` | rename |
| `DELETE /api/boards/:id` | soft delete (`deleted_at`), 204 |
| `GET /api/rooms/:id` | `{elements, version, updatedAt}`; 404 if never saved |
| `PUT /api/rooms/:id` `{elements}` | full-scene save (≤ 20 MiB); creates an "Untitled" board row if none (a `#room=` link opened before being listed); returns `{version, updatedAt}` |
| `GET /api/files/:id` | raw bytes, `Content-Type` from the row; 404 |
| `PUT /api/files/:id?board=<id>` | raw bytes ≤ 4 MiB (`FILE_UPLOAD_MAX_BYTES`), 201 |
| `POST /api/v2/scenes` → `{id}`, `GET /api/v2/scenes/:id` → bytes | opaque blobs for `#json=` share links (upstream `exportToBackend`) |

Tables: `boards(id text pk, name, room_key, created_by, created_at, updated_by, updated_at, deleted_at)`,
`scenes(board_id pk → boards, elements jsonb, version int, updated_at)`,
`files(id text pk, board_id, content_type, bytes bytea, created_at)`,
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

## Phase 2 — voice tool port

1. `whiteboard/src/*` → `excalidraw-app/voice/` (controller, fit, persist,
   capture, vad, stt, settings, panel, glyph). Hooks into `excalidraw-app/App.tsx`
   are the only touchpoints: toolbar button, main-menu "Voice settings…",
   pointer handlers, `excalidrawAPI`. Keep the file layout upstream-merge
   friendly (new files, few edited lines).
2. Persistence sweep (`persist.ts`: interim previews and markers are
   scaffolding) must also run on the collab load path, not only on reload.
3. `whiteboard/test/unit` → root vitest (`excalidraw-app/voice/__tests__`);
   Playwright e2e with the fake mic → `euidos/e2e/`, run against `vite preview`
   of the app build + the real STT. The round-5 gates (R5a ≤ 400 ms pen-up →
   words, interim while speaking, revert of a provisional region) must pass.
4. Kiosk scripts (`kiosk-probe/reload/restore`) → `euidos/scripts/`; the
   casebook `whiteboard/.re0` → `euidos/casebook` (git mv). Then delete
   `whiteboard/`.
5. Acceptance: unit + e2e green; hosted app on the tailnet origin transcribes
   through `/stt` (Playwright with the fake mic against the live host).

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
