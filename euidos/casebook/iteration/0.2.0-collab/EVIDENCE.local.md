# EVIDENCE — 0.2.0 collab, phase 1

Run of record for the shipped (post-review-fix) build: fork `excalidraw` master @ `cff7269f`, fleet-infra `main`
@ `dd22793` (both committed, neither pushed — the main loop pushes). Backend `test/run.sh` **41/41** (10 suites,
was 22 pre-review), app `yarn vitest run excalidraw-app/data/euidosStorage.test.ts` **18/18** (was 11),
`yarn vitest run excalidraw-app/tests/collab.test.tsx` **2/2**, `yarn test:typecheck` clean, `nginx -t` clean,
`bash -n scripts/deploy-whiteboard.sh` clean. Deployed with `fleet-infra/scripts/deploy-whiteboard.sh master`;
smoke + live probes below were run against the deployed containers on euidos-internal (100.99.114.55), read-only
except for e2e boards created and then soft-deleted by the run itself. A same-day cold-run resume (worktree
`excalidraw-coldrun`, discarded after) re-derived every number below from a fresh clone and found no drift.

## Phase-1 acceptance (collab-plan.md §"Acceptance")

| Item | Status | Proof / measured numbers |
| --- | --- | --- |
| Two Playwright browsers, one `#room=` link: shape drawn in A appears in B within 2 s | **met** | `euidos/e2e/collab-smoke.mjs`, 3 consecutive runs against the live tailnet origin: relay latency **10 ms / 10 ms / 13 ms** (drawn in A → rendered in B), well under the 2000 ms budget. |
| Both closed and reopened → shape still there (loaded from `/api/rooms`) | **met** | Same 3 runs: cold reopen in a third context showed the rectangle in all 3 (2303 px / 2288 px / — non-transparent pixel count, element-level truth from the API: `containerId: null`... i.e. `els.length === 1`, type `"rectangle"`). |
| `GET /api/boards` lists it | **met** | All 3 runs: name `"Untitled"`, `createdBy`/`updatedBy` = the identity making the request (`wall` from dev-woo, a tagged node), `elementCount: 1`. |
| Public origin answers 302 → Access for `/`, `/api/boards`, `/socket.io/` | **met** | `curl` from dev-woo: all three routes plus `/api/health` → HTTP 302 to `https://euidos.cloudflareaccess.com/cdn-cgi/access/login/board.euidos.ai?kid=<ACCESS_AUD>...` — the correct app-scoped redirect, not a generic one. |
| `/api/health` ok via both origins | **met** | Tailnet: `{"ok":true,"db":"ok"}`. Tunnel (from inside the compose net, bypassing Access, to prove the origin itself also gates): `GET web:80/api/me` with no token → `401`; with a forged `Tailscale-User-Login` header on the tunnel block → still `401` (nginx does not trust that header on `:80`). |

Save cadence measured on the real surface (not test slack — the app's own throttle): PUT lands at **13930–14231
ms** after pen-up across all 3 runs, matching `queueSaveToFirebase`'s `SYNC_FULL_SCENE_INTERVAL_MS = 20 s` with
`leading:false`. Phase 2 (voice) will see the same cadence unless it changes the save trigger.

## Deploy-stage smoke (host-level, all read-only except the e2e boards)

| Check | Status | Numbers |
| --- | --- | --- |
| Container health | **met** | `euidos.internal` (nginx), `euidos.internal.storage` (boards-storage:cff7269f), `euidos.internal.db` (postgres:16-alpine), `euidos.internal.room`, `euidos.internal.tunnel` all healthy; storage log's first line is `migrate applied 002_scene_elements_json.sql`. |
| Bundle identity | **met** | Served bundle hash `assets/index-yU0n1s2r.js` on the live tailnet listener matches a fresh cold build from the same commit (`cff7269f`) built in a throwaway worktree — proves what's live is what's in git, not a stale leftover. |
| `HEAD /api/health` | **met** | 200 (was 405 pre-fix; added to the deploy smoke checks). |
| Security headers on the shell/asset paths | **met** | `/` and `/assets/index-*.js` both carry `X-Content-Type-Options: nosniff` + `Referrer-Policy`, single `Cache-Control` header (was two conflicting values pre-fix). |
| `/stt/health` through nginx | **met** | `{"ok":true,"model":"large-v3-turbo","device":"cuda","compute":"float16","warm":true,"uptime_s":23263.5,"skipped":1}` — STT box confirmed untouched by phase 1. |
| Schema state on host | **met** | `schema_migrations` = `001,002`; `scenes.elements` `udt_name = json`; `scenes.element_count` present. |

## Review findings → fix status (one row per finding, most-severe first)

| Severity | Finding | Status | Evidence it's fixed |
| --- | --- | --- | --- |
| MUST | Stored-XSS via replayed `Content-Type` on `/api/files` (attacker-controlled `text/html`/`image/svg+xml` served from the app's own origin, zero credentials to write) | **fixed** | Live: `PUT` a file with `Content-Type: text/html`, then `GET` → replies `application/octet-stream` + `Content-Disposition: attachment` + `nosniff` + `Content-Security-Policy: default-src 'none'; sandbox`. Probe row deleted afterwards. Unit: `test/security.test.js` (content-type coercion, allowlisted images pass, hostile types coerced). |
| MUST | Lost update: non-atomic GET→reconcile→PUT with no precondition drops a concurrent writer's elements silently | **fixed** | `PUT /api/rooms/:id` takes optional `baseVersion`; stale write → 409, checked via `test/rooms.test.js` (two readers at v1: stale writer 409s, rectA survives; retry at v2 succeeds). App retries GET→reconcile→PUT up to 5× on 409 (`euidosStorage.test.ts`: both writers' elements survive across a 409, gives up after 5). |
| SHOULD | `/stt/` proxy forwarded the caller's full header set, leaking the Access session cookie/JWT to the STT desktop | **fixed** | Both nginx `/stt/` blocks blank `Cookie`/`Authorization`/`Cf-Access-*`/`Tailscale-User-*`/`X-Euidos-Listener`. `/stt/health` from both origins still answers ok (functionality preserved). Narrowing the location to one endpoint explicitly **not done** — see DESIGN deviations. |
| SHOULD | No CSRF defence; tailnet identity is ambient (no cookie to withhold) | **fixed** | Cross-site `POST` (forged `Sec-Fetch-Site`) → 403; foreign `Origin` → 403; `text/plain` on a JSON route → 415. Live-probed against the deployed origin after redeploy. |
| SHOULD | `via:"wall"` (credential-free tailnet fallback) had full admin power — delete/rename any board | **fixed** | Live: `DELETE /api/boards/:id` from dev-woo (a tagged node → `wall`) → 403; the same `DELETE` with a real `Tailscale-User-Login` header → 204. Reads and the room's own save are unchanged for `wall`. |
| SHOULD | A NUL byte in `elements` made a board permanently unsaveable (`jsonb` rejects NUL; `json` does not) | **fixed** | Migration `002_scene_elements_json.sql` applied in place on the host (confirmed: `udt_name = json`). Unit: a NUL-bearing scene saves and round-trips (`test/rooms.test.js`); migration idempotency + real upgrade path re-tested (`test/migrations.test.js`: a db created by 001 alone, with data, migrates in place with data/version intact). |
| NICE | `add_header` did not inherit into locations that declared their own — shell/assets served with no security headers, and two conflicting `Cache-Control` values | **fixed** | Live-probed post-redeploy (see deploy-stage table above). |
| NICE | Unguarded `decodeURIComponent` on path ids → 500 + stack trace to the container log | **fixed** | `GET /api/rooms/%E0%A4` → 400 (was 500), across all six call sites. |
| NICE | `HEAD` not dispatched → 405 on any GET route | **fixed** | `HEAD /api/health` → 200; added to deploy smoke. |
| NICE | 413 on `/api/v2/scenes` lacked `error_class`, so the app's existing "too big" branch (written for the Firebase functions backend) never fired | **fixed** | 413 body now includes `error_class: "RequestTooLargeError"`. |
| NICE | `elementCount` counted 24h-tombstoned (`isDeleted`) elements | **fixed** | `scenes.element_count` written at save time from live (non-`isDeleted`) elements. |
| SKIPPED | Unbounded/never-expiring blob+file store, no rate limiting or retention | **skipped, reasoned** | `limit_req` would key on a single shared IP (behind cloudflared/Serve) and throttle the founder, not an attacker; headroom 1.5T at 2% used. Growth pattern this round actually observed (idle-link "Untitled" boards) is separately fixed. Retention job deferred to phase 3 (owner named). |
| SKIPPED | App-wide Content-Security-Policy | **skipped, reasoned** | Excalidraw needs `'unsafe-inline'` styles + blob workers + data:/blob: images + a font CDN; a wrong policy live-breaks the board with no browser-pass proof available in this round. The XSS primitive it would guard is closed at source on `/api/files`/`/api/v2/scenes` instead. |

## Numbers worth carrying into phase 2/3 planning

- Collab propagation (draw in A → renders in B): **10 ms, 10 ms, 13 ms** (3 runs), tailnet origin, socket relay only.
- Cold reload persistence: rectangle survives in all 3 runs, loaded from `GET /api/rooms/:id`.
- Save latency after pen-up: **13930–14231 ms** (app's own 20 s throttle, not network/server latency).
- App bundle: `assets/index-yU0n1s2r.js`, 45 MB build size, from fork commit `cff7269f`.
- Storage image: `euidos/boards-storage:cff7269f`, shipped by `docker save | ssh docker load`.
- excalidraw-room: `sha-03ff435@sha256:2fe999f9be4379e3ee282fc45d75d84a691a6383dde33544514cc395287c7a70`
  (2023-vintage, socket.io 4.6.1 server against the app's 4.7.2 client — protocol-compatible, confirmed).
- Backend unit tests: 22 → 41 (post-review). App unit tests: 11 → 18 (post-review).
- Untracked residue discarded before this resume began (per the founder's own pause note): a partial,
  never-committed `euidos/storage-backend/` directory from an earlier attempt — not part of what shipped here.

## Open item carried from the deploy report, unresolved by this memo

- **Not provable from dev-woo**: Tailscale Serve injecting `via:"tailnet"` for an UNTAGGED (personal) device, and
  the Cloudflare Access branch end-to-end with a real login. Both are proven up to the edge (nginx turns a real
  `Tailscale-User-Login` into `via:"tailnet"` when injected directly on the host; the public origin correctly
  302s to Access) but need one browser check each from the founder's own device
  (`https://euidos-internal.pony-bellatrix.ts.net/api/me`, `https://board.euidos.ai/api/me`). Carried into
  RETRO as a phase-1 gate the founder — not an agent — must close.
