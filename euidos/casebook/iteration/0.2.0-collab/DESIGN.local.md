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
