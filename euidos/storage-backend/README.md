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
| `PATCH /api/boards/:id` `{name}` | rename, 200 board, 404 if unknown/deleted |
| `DELETE /api/boards/:id` | soft delete (`deleted_at`), 204 |
| `GET /api/rooms/:id` | `{elements, version, updatedAt}`, 404 if never saved |
| `PUT /api/rooms/:id` `{elements}` | full-scene save, `{version, updatedAt}`; creates an "Untitled" board row when the id is unknown |
| `GET /api/files/:id` | raw bytes with the stored `Content-Type` |
| `PUT /api/files/:id?board=<id>` | raw bytes, 201 `{id}` |
| `POST /api/v2/scenes` | raw bytes in, `{id}` out (201) |
| `GET /api/v2/scenes/:id` | the bytes back, `application/octet-stream` |

A board is `{id,name,roomKey,createdBy,createdAt,updatedBy,updatedAt,elementCount}`.

Behaviours worth knowing:

- `PUT /api/rooms/:id` bumps `version` by one per save and stamps
  `boards.updated_at/updated_by` — that is what orders the board list.
- A rename does **not** touch `updated_at`: "newest edit first" means the newest
  *scene* edit, so renaming does not reshuffle the list.
- Soft-deleted boards are invisible everywhere: their rooms 404, a rename 404s,
  and a second `DELETE` is a no-op 204 (404 only if the id never existed).
- `PUT /api/files/:id` overwrites an existing id (content-addressed upstream);
  `board` is recorded for housekeeping only, there is no foreign key, because a
  file can be uploaded before the board row exists.
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
(one row per board, `elements jsonb`, `version`), `files` (bytea), `blobs`
(`#json=` share payloads). Adding a migration = adding `NNN_name.sql`; never
edit one that has shipped.

## Running it

```bash
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
file roundtrip + limit, `/api/v2/scenes` roundtrip, migration idempotency.

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
