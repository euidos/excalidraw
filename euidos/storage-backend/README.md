# boards storage backend

The persistence layer for the euidos collaborative whiteboard: board index,
scenes, image files and `#json=` share blobs in PostgreSQL. It replaces
Firebase in `excalidraw-app/`. Node 22, ESM, two dependencies (`pg`, `jose`).

The contract it implements is fixed by `euidos/docs/collab-plan.md`; the
platform rules it lives under are `fleet-infra/docs/internal-platform-notes.md`.

## Routes

Everything except `/api/health` needs an identity. JSON unless noted; errors are
`{error, message}` with a 4xx/5xx status.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | `{ok:true, db:"ok"}` (503 + `{ok:false,db:"error"}` if the db is down) — no auth |
| `GET /api/me` | `{login, name, via:"access"\|"tailnet"\|"wall"}` |
| `GET /api/boards` | `{boards:[…]}` — not deleted, newest edit first |
| `POST /api/boards` `{id,roomKey,name}` | 201 board, 409 if the id exists |
| `PATCH /api/boards/:id` `{name}` | rename, 200 board, 404 if unknown/deleted, **403 for the wall** |
| `DELETE /api/boards/:id` | soft delete (`deleted_at`), 204, **403 for the wall** |
| `GET /api/rooms/:id` | `{elements, version, updatedAt}`, 404 if never saved |
| `PUT /api/rooms/:id` `{elements, baseVersion?}` | full-scene save, `{version, updatedAt}`; 409 if `baseVersion` is stale; creates an "Untitled" board row when the id is unknown |
| `GET /api/files/:id` | raw bytes, always as a guarded download (see below) |
| `PUT /api/files/:id?board=<id>` | raw bytes, 201 `{id}` |
| `POST /api/v2/scenes` | raw bytes in, `{id}` out (201) |
| `GET /api/v2/scenes/:id` | the bytes back, `application/octet-stream` |

A board is `{id,name,roomKey,createdBy,createdAt,updatedBy,updatedAt,elementCount}`.

Behaviours worth knowing:

- `PUT /api/rooms/:id` bumps `version` by one per save and stamps
  `boards.updated_at/updated_by` — that is what orders the board list.
- **`baseVersion` is the concurrency control.** The client's save is a
  read-modify-write (GET the stored scene, `reconcileElements`, PUT the merge).
  Without a precondition two overlapping saves silently drop one side's
  elements — Firestore's `runTransaction` is what used to prevent that. Send
  the `version` the merge was based on (`0` = "the room did not exist"); a
  mismatch is `409 {"error":"conflict"}` and the caller must re-read, re-merge
  and retry. Omitting `baseVersion` keeps last-writer-wins, for scripts.
- `elementCount` counts the elements a human can see: the stored array also
  carries `isDeleted` tombstones for 24 h, and counting those makes an emptied
  board look full for a day. It is computed at write time (`scenes.element_count`).
- A rename does **not** touch `updated_at`: "newest edit first" means the newest
  *scene* edit, so renaming does not reshuffle the list.
- Soft-deleted boards are invisible everywhere: their rooms 404, a rename 404s,
  and a second `DELETE` is a no-op 204 (404 only if the id never existed).
- `PUT /api/files/:id` overwrites an existing id (content-addressed upstream);
  `board` is recorded for housekeeping only, there is no foreign key, because a
  file can be uploaded before the board row exists.
- **A stored file is never a page.** Files are served from the app's own origin,
  so replaying a caller-chosen `Content-Type` would be stored XSS. The declared
  type is kept only if it is in a small allowlist (`application/octet-stream`
  and the raster image types); everything else — `text/html`, `image/svg+xml`,
  `application/javascript` — becomes `application/octet-stream`. Every file and
  blob response also carries `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src
  'none'; sandbox`. The real client only ever uploads `application/octet-stream`.
- **Writes must be same-origin.** Identity here is ambient (it comes from the
  connection, not from a cookie a browser could withhold), so a hostile page on
  a tailnet device could otherwise make credentialed writes. Any state-changing
  request with `Sec-Fetch-Site` other than `same-origin`/`none`, or with a
  foreign `Origin`, is `403`; the JSON routes additionally require
  `Content-Type: application/json` (`415` otherwise), which no cross-origin
  `<form>` can produce. Requests with neither header (curl, the e2e script) pass.
- **The wall is a display, not an administrator.** `via:"wall"` is what any
  credential-free request on the tailnet listener becomes, so it may read and
  save the room it is showing but may not rename or delete boards (403).
- `HEAD` is answered like `GET` (uptime probes).
- Ids (`board`, `room`, `file`, `scene`) must match `[A-Za-z0-9_-]{1,128}`.
- Every request is logged as one line, `method path status ms login`, never a body.

## Identity — what is trusted, and why

Resolution order (`src/identity.js`), exactly as the plan fixes it:

1. `Cf-Access-Jwt-Assertion` present → verified with `jose` against the team
   JWKS (`https://$ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs`, cached in process,
   refetched when a `kid` is unknown), `aud` must equal `ACCESS_AUD` and `iss`
   the team domain → `via:"access"`, login = the `email` claim (`common_name`
   for service tokens). A present-but-invalid token is a 401, never a fallback.
2. else `X-Euidos-Listener: tailnet` — set by nginx's tailnet server block only,
   and stripped from client requests on both blocks → `Tailscale-User-Login`
   present → `via:"tailnet"`; absent (a tagged device, i.e. the wall PC) →
   `via:"wall"`, login `wall`. Any other value of the header is untrusted and
   ignored.
3. else 401.

So the service never reads a Tailscale header on the tunnel listener and never
trusts `Cf-Access-Authenticated-User-Email` (convenience, not proof). If nginx
ever forwarded a client-supplied `X-Euidos-Listener: tailnet`, that would be the
whole authentication — the two nginx server blocks are part of this security
boundary.

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | listen port |
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_NAME` / `PG_PASSWORD` | `db` / `5432` / `boards` / `boards` / — | connection |
| `ACCESS_AUD` | — | the Access application's aud tag (public, not a secret) |
| `ACCESS_TEAM_DOMAIN` | — | e.g. `euidos.cloudflareaccess.com` |
| `MAX_SCENE_BYTES` | `20971520` (20 MiB) | `PUT /api/rooms/:id` and `POST /api/v2/scenes` |
| `MAX_FILE_BYTES` | `4194304` (4 MiB) | `PUT /api/files/:id` |

Size limits are enforced from `Content-Length` *and* while the body streams, so
an oversized chunked upload is cut off at the limit — nothing is parsed or
written. Over the limit is `413 {"error":"too_large"}`.

## Schema and migrations

`migrations/*.sql` are applied at start-up in filename order, each in its own
transaction, recorded in `schema_migrations(version, applied_at)`, and written
to be idempotent (`CREATE TABLE IF NOT EXISTS`). Tables: `boards`, `scenes`
(one row per board, `elements json`, `element_count`, `version`), `files`
(bytea), `blobs` (`#json=` share payloads). Adding a migration = adding
`NNN_name.sql`; never edit one that has shipped.

`scenes.elements` is `json`, **not** `jsonb`, and must stay that way: `jsonb`
cannot represent a NUL (or a lone surrogate), so one `U+0000` pasted into a text
element would make that board permanently unsaveable — every later `PUT` 500s.
For the same reason nothing inspects the document with `->`, `->>` or
`json_array_elements`: those unescape text and fail on exactly that input.

### Undoing a delete

`DELETE /api/boards/:id` is a soft delete and there is no restore route yet
(phase 3). Recovery is one statement on the host:

```bash
docker compose exec -T db psql -U boards -d boards \
  -c "UPDATE boards SET deleted_at = NULL WHERE id = '<board id>'"
# what was deleted, most recent first
docker compose exec -T db psql -U boards -d boards \
  -c "SELECT id, name, deleted_at FROM boards WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
```

## Running it

To develop against the app's `yarn start`, run the service on :3000 — the dev
server proxies `/api` to it (`excalidraw-app/vite.config.mts`):

```bash
docker run --rm -d --name boards-dev-db -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine
npm ci
PG_HOST=127.0.0.1 PG_PORT=55432 PG_USER=postgres PG_NAME=postgres PG_PASSWORD=test \
ACCESS_AUD=<aud tag> ACCESS_TEAM_DOMAIN=euidos.cloudflareaccess.com \
  node src/server.js
```

Image (built on dev-woo, shipped with `docker save | ssh root@euidos-internal docker load`):

```bash
docker build -t euidos/boards-storage:<tag> .
```

It runs as the `node` user and has a `HEALTHCHECK` on `/api/health`.

## Tests

```bash
./test/run.sh          # starts postgres:16-alpine on 127.0.0.1:55432, runs node:test, removes it
KEEP_DB=1 ./test/run.sh   # keep the container for a rerun
```

They are integration tests (`node:test`) against the real database: health,
401 without identity, tailnet/wall identity, a locally signed RS256 Access token
against an injected key set (wrong `aud`, wrong `iss`, wrong key and garbage all
rejected), boards CRUD + soft-delete ordering, room save/version/limit,
file roundtrip + limit, `/api/v2/scenes` roundtrip, migration idempotency and
the 001→002 upgrade path, plus the phase-1 review regressions in
`test/security.test.js` (content-type coercion, CSRF, wall authorisation,
malformed ids, HEAD) and in `test/rooms.test.js` (the lost-update race, NUL
scenes, tombstone-free `elementCount`).

## Backup and restore

The database is `euidos-internal`'s stack Postgres (see that stack's README for
the nightly `pg_dump` into `/opt/backups/euidos-internal/` and the off-host copy).

```bash
# backup (on the host)
docker compose exec -T db pg_dump -U boards -d boards --format=custom > boards-$(date +%F).dump

# restore into an empty database
docker compose exec -T db pg_restore -U boards -d boards --clean --if-exists < boards-YYYY-MM-DD.dump
```

`bytea` columns (files, blobs) make the dump grow with pasted images; the custom
format compresses them. A restore drill belongs in the stack runbook: restore
into a scratch database, `SELECT count(*) FROM boards`, then drop it.
