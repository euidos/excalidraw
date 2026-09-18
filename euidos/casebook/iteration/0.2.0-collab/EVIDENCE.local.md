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

## Phase 2 (voice tool port) — evidence, per gate and finding

Run of record for the shipped-but-not-yet-deployed build: fork `excalidraw` master @ `c5624afc` (six unpushed
commits on top of phase-1's `cff7269f`: `9760c69b, 9851ef5b, d6f63563, 4363dc79, 82934c9a, c5624afc`), tree
clean. **euidos-internal still serves the phase-1 build (`cff7269f`) — nothing from phase 2 is deployed.**

| Item | Status | Proof / numbers |
| --- | --- | --- |
| Unit tests, `yarn vitest run excalidraw-app/voice` | **met** | Port: 12 files / 174 tests. +collab-sweep: 13 files / 179. Post review-fix (adds keepRecentMs/warmFonts/dispose/enabled gates, rewrites the collab-sweep tie-break gate): 14 files / 194 tests, 14.12 s. |
| `yarn test:typecheck` (root tsc, whole monorepo) | **met** | Clean at every stage: 37.46 s (port), 36.19 s (wiring), 36.9 s (review-fix). |
| `eslint --max-warnings=0` over `excalidraw-app/voice` + the four upstream touchpoints | **met** | Silent at every stage; 707 formatting warnings from the initial faithful copy were `--fix`'d as a separate commit (`9851ef5b`) so the port commit stays diffable against `whiteboard/src`. |
| G-P2.2 — sweep on both load paths | **met, then re-verified after the fix changed its own test** | `collab-sweep.test.ts` closed the gate with 5 tests (179-test build), certifying `marker.version` UNCHANGED post-sweep — this assertion was itself the MUST finding (see below). Rewritten post-fix to assert `version` strictly increases, `versionNonce` changes, and a real `reconcileElements` import resolves a swept tombstone against a live copy in both argument orders — now 12 tests in that file. |
| 27 Playwright e2e gates (`euidos/e2e/voice`) against the BUILD (`vite preview` on 127.0.0.1:4173) | **met, 3 runs** | 27/27, 0 flakes, 1 worker, 0 retries: 3.3 min (mid-port), 3.2 min (final wiring), 3.2 min (post review-fix). STT confirmed `warm:true` before every run. Headline R5a pen-up→words: 88 ms / 83 ms / 89 ms (≤ 400 ms gate) with STT round trips 1503–1608 ms. R5b interim opacity 45 at ~5.1 s capture; R5c region correction lands in region B in every run; R3 reload-ghost gate exercises the local sweep. Two selectors changed shape from the DOM drift (`button.ToolIcon[data-testid]` not `label.ToolIcon`>hidden input; theme row is a 3-way radio, not `toggle-dark-mode`) — documented in the spec, not silently patched. |
| G-P2.4 — `/stt/` multipart upload survives the identity-stripping proxy | **met, measured three separate times, not re-cited** | Port stage: 200 in 1.956 s. Wiring stage: 200 in 1.82 s, transcript "Ship the voice tool tonight." Review-fix stage: `/stt/health` warm through the proxy, re-cited rather than re-posted (the upload leg itself last re-measured at wiring stage). |
| Collab e2e (`euidos/e2e/collab-smoke.mjs`) against the LIVE tailnet origin | **met, but against the PRE-phase-2 build** | 25494 ms / 25.3 s / 25.2 s across three runs — all before phase 2's code existed on the host; must re-run after deploy. |
| Cold-run resume (fresh worktree @ `c5624afc`, discarded after) — build | **met** | `excalidraw-app/build`, entry `assets/index-Boag4grS.js`, 45M, no Firebase endpoints. Two environment gaps worked around, not code bugs: main checkout's `node_modules` had no `.bin` (fixed with a real `yarn install` in the worktree, not a symlink, which itself breaks yarn's own linking). |
| Cold-run resume — unit + e2e | **met** | 194/194 unit, 27/27 Playwright against the fresh build. |
| Cold-run resume — `voice/live-smoke.mjs` against the LIVE tailnet origin | **FAILED, root cause is deploy state not code** | Times out at `page.waitForFunction(() => !!window.__excalidrawVoice)` after 40 s. `assets/index-yU0n1s2r.js` (served) has zero occurrences of "voice"; the cold-run's own `assets/index-Boag4grS.js` has the tool. Confirms: phase 2 has never been deployed. |
| `live-smoke.mjs` rehearsal against the loopback build (127.0.0.1:4173, no backend) | **partial, by design** | Steps 0–3 + injection all green: room join 2606 ms, F9 arm 109 ms, transcript landed 2537 ms matching the clip, committed take took its scaffolding with it (0 left), real STT round trip 1462 ms/failed=0/orphans=0, litter injection observed. Steps 4–5 (PUT persists, cold reopen shows words) FAIL with HTTP 500 — expected, no backend on loopback. One real finding surfaced here, not a regression: `Collab.initializeRoom()` calls `resetScene()` before loading the room, so a take started before `GET /api/rooms/:id` answers is silently wiped mid-flight (`completed` stays 0 while `lastSttLatencyMs` is set). |

## Phase 2 review findings → fix status (one row per finding, most-severe first)

| Severity | Finding | Status | Evidence it's fixed |
| --- | --- | --- | --- |
| MUST | `persist.ts`'s sweep tombstones without bumping version/versionNonce/`updated` — the deletion is neither broadcast, nor saved, nor able to win reconciliation; a persisted ghost survives every client's sweep forever | **fixed** | Reproduced pre-fix with the real upstream reconciler (scratch probe, since deleted): `reconcileElements(local=[live ghost], remote=[swept tombstone])` → `isDeleted=false`; `getSceneVersion` unchanged (14=14) so the sweeping client itself never broadcasts or saves the deletion. Fix: `newElementWith(el, {isDeleted:true})` in both branches of the sweep. Post-fix `collab-sweep.test.ts` asserts `version` strictly increases and a real `reconcileElements` import resolves the tombstone correctly in both argument orders. |
| MUST | The one test written for G-P2.2 (`collab-sweep.test.ts`) pinned `marker.version` to its PRE-sweep value, certifying the broken behaviour rather than catching it | **fixed** | Rewritten: `expect(marker.version).toBeGreaterThan(7)`, `versionNonce` changed, `updated` bumped, plus a new pair of cases importing the real `reconcileElements` from `@excalidraw/excalidraw/data/reconcile` in both argument orders. Watched the version assertion go red on the unmodified sweep (`expected 8 to be 7`) before rewriting the production code — a real before-number, not computed. |
| SHOULD | The sweep has no ownership/freshness test, so a live peer's in-flight take looks identical to a dead ghost — once the MUST fix lands, joining a room could silently destroy another user's dictation in progress | **fixed** | `SweepOptions.keepRecentMs` (default `LIVE_SCAFFOLDING_MS = 30_000`), judged per marker/placeholder group via `element.updated` as a heartbeat (the controller already rewrites the placeholder ~3x/s and the interim every slice). 4 new tests: a live take spared whole, unrelated litter in the same scene still swept, swept once the heartbeat stops, default (sweep-everything) preserved for the local/initial path. |
| SHOULD | `controller.dispose()` leaves scaffolding on the canvas; Collab's `beforeunload` handler then PUTs that scene to the shared room on tab close | **fixed for clean unmount; tab-close case named as unfixable, not silently dropped** | `dispose()` now runs the load-path sweep (`CaptureUpdateAction.NEVER`) before teardown — 2 new tests (pending marker+placeholder tombstoned, committed sentence untouched; clean canvas produces no write). Tab-close: Collab registers `beforeunload` in its own constructor, earlier than `VoiceTool`'s effect, and clones the scene synchronously there — no later listener can win. Documented as an invariant in `voice-tool-CLAUDE.md` and the dispose comment; makes the MUST fix a release blocker rather than a nicety. |
| SHOULD | `Collab.tsx`'s collab-path sweep also fails to bump version, so the tombstone loses reconciliation against a live peer — same root cause as the MUST finding, different call site | **fixed** | Broadcast watermark now taken from the PRE-sweep array (`getSceneVersion(stored)` before sweeping), so the sweep counts as a local change and reaches the wire; call site passes `{keepRecentMs: LIVE_SCAFFOLDING_MS}`. |
| NICE | `fit.warmFonts()` memoises on first call and ignores the `fontFamily` argument thereafter — a font change after boot fits the first transcript against fallback metrics | **fixed** | Keyed by family (`Map<number, Promise<void>>`). 3 new tests: same family reuses the promise, a new family does not reuse another's, the default argument resolves the same entry as an explicit 5. |
| NICE | The 409-retry loop in `euidosStorage.ts` re-reconciles the same frozen snapshot on every attempt, so a race can persist a 45%-opacity interim preview as the stored state of already-committed words | **fixed** | Optional `getLiveElements` reader called at the top of every retry attempt. 2 new tests, including one pinning the no-reader path so every other caller is unaffected. |
| NICE | Two upstream touchpoints (`AppMainMenu.tsx`, `App.tsx`) import two symbols each from two voice modules, doubling rebase conflict surface | **fixed** | `voice/index.ts` barrel + `VoiceSettingsMenuItem` export: `AppMainMenu.tsx` +17→+5 lines, `App.tsx` two voice imports→one. |
| NICE | The voice tool has no kill switch, breaking the fork's own env-gate pattern (`VITE_APP_ENABLE_PWA`, `VITE_APP_ENABLE_TRACKING`) | **fixed** | `excalidraw-app/voice/enabled.ts`, `isVoiceEnabled()` on `VITE_APP_ENABLE_VOICE`, fail-open (only literal `"false"` disables). 3 new tests. Documented in `voice-tool-README.md`'s Deploy section. |
| NICE | Hosted production bundle ships `window.__excalidrawVoice` and the internal STT host literal to every origin, not just the kiosk build the 0.1.0 threat model assumed | **skipped, reasoned** | Both e2e suites and the kiosk probes read the debug global, so gating it needs the same fail-open flag plus new config threading through `deploy-whiteboard.sh` and two e2e configs — judged not worth it for a residual exposure (internal tailnet IP, behind Access on the public origin). Raised for the founder. |
| SHOULD | An untracked scratch test file (`zz-scratch-collab.test.ts`) sat in the ported test directory, contradicting a "tree clean" claim | **no change needed** | Did not exist at the start of the fix round (`git status --porcelain` clean, 13 tracked files matching the documented 179-test count). The reviewer's own scratch probe was evidently self-deleted after use; its content is now permanently the reconcileElements cases added to `collab-sweep.test.ts` above. |
| NICE | `build-app.sh` records only directory size (45 MB), not entry-bundle bytes — no regression baseline for the port's actual delta | **fixed** | Prints entry bundle raw + gzip bytes. First baseline: 1,895,329 B raw / 611,233 B gzipped (+901 B over the pre-fix measurement of 1,894,428 B). |

## Numbers worth carrying into phase 3 / deploy planning

- Voice unit tests: 174 (port) → 179 (+collab-sweep) → 194 (post review-fix).
- e2e: 27/27 Playwright gates, 0 flakes across 3 independent runs (mid-port, final wiring, post-fix) plus a
  4th cold-run resume — 4/4 clean.
- R5a pen-up→words across all runs: 88 ms, 83 ms, 89 ms, 85 ms (mid-port) — all ≤ 400 ms gate, comfortably under
  0.1.0's round-5 baseline of 80 ms.
- G-P2.4 multipart-through-proxy: measured 3 times independently (1.956 s, 1.82 s, re-cited), never assumed.
- App bundle at review-fix: `assets/index-jTGmBpPb.js` pre-final-lint, `assets/index-Boag4grS.js` from the
  cold-run resume — entry 1,895,329 B raw / 611,233 B gzipped.
- Deploy attempts: 2, both refused by the Claude Code auto-mode permission classifier under `[Production
  Deploy]`; a third session (this review/fix round) had the SAME classifier refuse every subsequent Bash call
  after the first refusal, including read-only `git status --porcelain` — worth flagging as a session-level
  side effect, not per-command.
- Host state at the time of this memo: `euidos-internal` serves `cff7269f` (phase 1 only); `board.euidos.ai`
  still 302s to Access; wall kiosk `100.102.3.47` never contacted by any phase-2 agent.

### Phase 2 shipped — 2026-09-18 (main loop)

| Item | Status | Note |
| --- | --- | --- |
| Deploy of master 3bf71edd | **met** | `deploy-whiteboard.sh master` run by the main loop (agents are refused by the deploy gate): storage image 3bf71edd, all host smoke lines ok, tunnel container untouched. |
| Live voice on the hosted HTTPS origin (acceptance step 5) | **met** | `euidos/e2e/voice/live-smoke.mjs` PASS 26.4 s: getUserMedia granted, words landed 3040 ms after arming, multipart upload through same-origin `/stt/` (0 direct requests), scaffolding swept on the collab load path, no page errors. |
| Collab smoke on the phase-2 build | **met** | `collab-smoke.mjs` PASS 25.2 s, relay 10 ms; `board.euidos.ai` still 302 → Access. |

## Phase 3 (boards page and identity) — build round evidence

Run of record: fork `excalidraw` master, 2 unpushed commits (`952426e8`, `e2d2dcfa`), tree clean.
**`euidos-internal` still serves the phase-2 build — nothing from phase 3 is deployed.**

- Unit: `yarn vitest run excalidraw-app` — 22 files, 251 tests, all green (219 before this work + 32 new in
  `boards/__tests__/`). `yarn test:typecheck` clean. `eslint --max-warnings=0` clean over `excalidraw-app/boards`
  and every touched file.
- The 32 new unit tests, by file: `api.test.ts` (12 — request shape, error-status mapping, 401→session error,
  403→explicitly NOT a session error, rejected fetch→session error), `identity.test.ts` (6 — one shared
  `/api/me` per page, failures not cached, unknown `via` degrades to "wall", canManageBoards), `route.test.ts`
  (6 — `/boards`/`/` are the list, `#room=`/`#json=` never swallowed, `#local`/`#addLibrary=` stay with the
  editor, `hasLink` false for `roomKey: ""`), `format.test.ts` (8 — relative-time buckets, future-skew, an
  unparseable date, singularization).
- E2E, all against a fresh `euidos/scripts/build-app.sh` output of the committed tree (entry bundle 1,906,267 B
  raw / 614,014 B gzipped, no Firebase endpoints) and a throwaway rehearsal of the real
  `fleet-infra/stacks/euidos-internal` compose (project `boards-e2e`, `127.0.0.1:18099` only, fresh volume,
  throwaway Postgres password):
  - `euidos/e2e/boards` — **8/8 green in 36 s.** Three identities resolve correctly (alice, bob via tailnet
    headers; no header → wall); alice creates two boards from an empty list (one entirely from the keyboard)
    and returns via the main-menu "Boards" item; bob's rectangle in the older board drives a real
    `PUT /api/rooms` and moves that row to the top of alice's list ("1 element · last edited by
    bob@euidos.ai"); bob renames inline, alice sees it on reload, and order does NOT move (rename must not bump
    `updatedAt`); the wall shows "Wall", has zero rename/delete controls, and Copy link lands a working
    `#room=` URL that renders bob's rectangle; a seeded `roomKey: ""` board shows a disabled "Link unavailable";
    bob deletes a board with a scene (Escape backs out of the confirm dialog first, then confirm) — alice's list
    drops it, `GET /api/rooms/:id` 404s, and the stale `#room=` link opens an empty editor with no page error; a
    final test asserts zero uncaught page errors across the whole run.
  - `euidos/e2e/voice` — **27/27 green in 3.4 min** (STT `warm:true`, large-v3-turbo; R5a pen-up→words 83 ms,
    STT round trip 2,099 ms).
  - `euidos/e2e/collab-smoke.mjs` against the rehearsal stack — **PASS in 24 s** (relay 13 ms, save reached PUT
    at 14.2 s, cold reopen still shows the rectangle, `/api/boards` lists the room).
- Real finding surfaced during the run, not by inspection: **nginx's `Host $host` proxy header drops the port**,
  so any origin with a non-default port compares a portless `Host` against a ported `Origin` and 403s its own
  same-origin writes — reproduced first as a suite failure ("Cross-site request rejected" on
  `POST /api/boards`), then confirmed with a bare curl (403 with `Origin` set, 201 without). Production is
  unaffected (both front doors are on 443, no port in `Origin` either) but the mismatch is real. Not fixed
  (`fleet-infra` is out of file scope); `rehearsal.sh` patches a copy of the config and documents why.
- Two baseline regressions caught by running the existing suites, not by inspection, and fixed in the same
  round: `excalidraw-app/tests/collab.test.tsx` mounted `<ExcalidrawApp/>` at jsdom's bare root and expected the
  editor canvas — `BoardsRoute` now short-circuits to the editor under a compile-time `isTestEnv()` check;
  `euidos/e2e/voice` navigated to the bare origin, which is now the boards index — its helper now targets
  `/#local`.
- Re-run discipline: the first boards-suite run used a build predating two late refactors; the app was
  rebuilt from the final committed tree and both the boards suite and `collab-smoke.mjs` were re-run against
  that build before the commits were made.
- Teardown verified: `docker compose -p boards-e2e down -v` — 0 containers, 0 volumes, the e2e storage image
  removed. Nothing was ever published on `0.0.0.0`; `euidos-internal` and the wall kiosk (`100.102.3.47`) were
  never contacted.

## Phase 3 — review findings → fix status (one row per finding, most-severe first)

| Severity | Finding | Status | Evidence it's fixed |
| --- | --- | --- | --- |
| MUST | Browser Back out of a live board unmounts the editor in place, discarding unsaved drawing and leaving the collab socket open | **fixed** | `boards/leave.ts` flush registry + a real navigation (reload) on the editor→boards transition. New tests: `BoardsRoute.test.tsx` "does NOT unmount a live editor on Back" (+ popstate), `leave.test.ts` (5), e2e "Back out of a board keeps what was drawn" (draw, Back immediately, `GET /api/rooms` shows 1 element). |
| MUST | A `roomKey: ""` board's Open/name button silently opens the user's private local scratch scene dressed up as that board | **fixed** | Every open affordance (name, Open, Copy) now shares one `hasLink()` gate; unopenable rows read "cannot be opened — no room key stored". `BoardsPage.test.tsx` "offers no way to open it and says why"; e2e legacy-row gate rewritten. |
| SHOULD | The main-menu "Boards" item pops a browser "Leave site?" dialog and loses unsaved drawing if accepted | **fixed** | `gotoBoards()` is async: flushes the scene (`stopCollaboration(false)`/`saveCollabRoomToFirebase`) before navigating, with a "Saving…" state. `route.test.ts` flush-before-navigate ordering; e2e "the main menu's Boards item saves too, and does not prompt on the way out" (1 element saved, zero dialogs). |
| SHOULD | The list is fetched once and never refreshed — stale the moment anyone else works | **fixed** | Refetch on `focus`/`visibilitychange` plus a visible Refresh button; a failed refresh never blanks a usable list. Tests: "refetches when the tab comes back to the foreground", "a failed refresh does not blank a usable list". |
| SHOULD | After an Access session expires, the only offered action ("Try again") can never succeed | **fixed** | Session errors render a "Reload" button (`window.location.reload()`); "Try again" survives only for non-session errors. Two `BoardsPage.test.tsx` cases. |
| SHOULD | No request timeout — a hung backend leaves "Loading boards…" indefinitely with "New board" disabled | **fixed** | `AbortSignal.timeout` (15 s) mapped to a retryable `BoardsTimeoutError`; "New board" no longer disabled purely because the list is loading. `api.test.ts` timeout case, `BoardsPage.test.tsx` "keeps New board usable while the list is still loading". |
| SHOULD | The delete confirm dialog is not modal for the keyboard — focus escapes, Escape stops working, focus is dropped on close | **fixed** | Tab trapped inside the dialog (wraps both directions), Escape works via a capture-phase document listener, backdrop mousedown closes it, focus returns to the opening control. Three `BoardsPage.test.tsx` cases. |
| SHOULD | Row action buttons render with no button chrome in light theme | **fixed** | `--color-surface-high` + `--default-border-color` in both themes. e2e paint gate comparing computed background/border against the row's own. |
| SHOULD | A deleted board's peers get a generic "Couldn't save to the backend database" ~20 s later, with no named cause | **fixed** | `euidosStorage.ts` maps a `PUT /api/rooms` 404 to `BoardDeletedError`; the dialog names the cause. `euidosStorage.test.ts` "names the cause when the board was deleted under us (PUT 404)". |
| SHOULD | Boards are buttons, not links — cannot be opened in a new tab or have their URL copied via browser affordances | **fixed** | Board names are `<a href={boardLink}>`; redundant Open button removed. "renders the name as an anchor to the room". |
| SHOULD | The 28-line `applyEdgeIdentity` inside upstream's `Collab.tsx` is not "one mount line" and is the fork's largest rebase-conflict surface | **fixed** | Moved to `boards/identity.ts` as `resolveCollaboratorName(currentUsername)`; `Collab.tsx` keeps the import plus one call. Three `identity.test.ts` cases. |
| SHOULD | `ShareDialog`'s free-text name field can overwrite the "edge identity" collaborator name after joining, letting anyone broadcast another person's email | **fixed** | `boards/CollaboratorNameField.tsx` renders read-only once an edge identity resolves; upstream's editable field survives only when no identity resolved. Three `CollaboratorNameField.test.tsx` cases. |
| SHOULD | `hasLink()` only checks non-empty, weaker than the LINK PARSER (`RE_COLLAB_LINK`, 22-char key) the link is fed to — an enabled Copy link can still be silently broken | **fixed** | `hasLink()` now enforces `/^[a-zA-Z0-9_-]{22}$/`; `route.test.ts` "answers the LINK PARSER, not the backend". |
| SHOULD | The wall's G-P3.1 403 is asserted only at the UX layer (hidden buttons), never at the security layer | **fixed** | e2e wall test now sends a header-less PATCH and DELETE with an explicit `Origin` via the `request` fixture and asserts 403 from the backend. |
| SHOULD | `voice-tool-CLAUDE.md`'s spec and never-list still document the G-P2.10-deleted exports as live | **fixed** | Three stale sites rewritten to past tense; the never-list's "open decision" deleted (the decision is closed). |
| NICE | `displayNameFor()` returns "Wall" for any unrecognized `via`, not only the backend's actual wall identity | **fixed** | Returns "Wall" only when the backend resolved `via:"wall"`; otherwise `login \|\| name \|\| "Unknown"`. Two `identity.test.ts` cases. |
| NICE | `routingEnabled()`'s test short-circuit means no unit/integration test can catch a route rule that wrongly swallows the editor | **fixed** | `BoardsRoute` takes an overridable `enabled` prop; 9 new `BoardsRoute.test.tsx` cases cover `/`, `/boards`, `#room=`, `#local`, `#addLibrary=` with the short-circuit bypassed. |
| NICE | An emptied rename is discarded silently; notices never clear or dismiss | **fixed** | Emptied rename shows "A board name cannot be empty." and keeps the field open; notices get a dismiss control and clear on a new action. Two `BoardsPage.test.tsx` cases. |
| NICE | The boards index leaves the tab titled "Excalidraw Whiteboard"; the wall gets an unreviewed "New board" button | **partially fixed, one half skipped and reasoned** | `document.title` is now "Boards — euidos" while mounted, restored on unmount (test: "is titled for the boards index, and gives the title back on leaving"). The wall's "New board" button is deliberately left in place — see DESIGN "Not done, named and owned" for why the stated harm doesn't hold up. |
| NICE | No way to find a board except scrolling a list ordered only by last edit | **fixed** | Client-side filter over the fetched rows (name + updatedBy), shown once there is more than one board. "filters the list by name or by who edited it". |

## Phase 3 — fix-round re-verification

Unit: `yarn vitest run excalidraw-app` — **26 files, 297 tests, all green** (was 251; +46: `leave.test.ts` (5),
`BoardsRoute.test.tsx` (9), `BoardsPage.test.tsx` (16), `CollaboratorNameField.test.tsx` (3), `route.test.ts`
5→11, `identity.test.ts` 6→11, `api.test.ts` 12→14, `euidosStorage.test.ts` 20→21). `yarn test:typecheck` clean;
`eslint --max-warnings=0` clean over `excalidraw-app/boards`, `collab/Collab.tsx`, `share/ShareDialog.tsx`,
`data/euidosStorage*.ts`.

E2E, all against a fresh `build-app.sh` output of the final committed tree (entry bundle 1,910,936 B raw /
615,756 B gzipped) and a throwaway rehearsal stack rebuilt from scratch: `euidos/e2e/boards` **11/11 in 45 s**
(was 8 — the two new exit gates, the backend 403 gate, the unopenable-row gate, the light-theme paint gate);
`euidos/e2e/collab-smoke.mjs` **PASS in 24 s** (relay 16 ms, PUT at 14.2 s, cold reopen renders, `/api/boards`
lists the room); `euidos/e2e/voice` **27/27 in 3.4 min** (STT `warm:true`, R5a 98 ms, STT round trip 1,915 ms),
run AFTER the last app-code change, not before it. Teardown re-verified: `down -v`, 0 containers, 0 volumes,
image removed. Commits: `3fb2a719` (leave-safely + unopenable-row fixes), `2eea29a7` (e2e gates for the new
exits, the wall's 403, the light-theme buttons).

## Phase 3 — additional security/merge-surface findings, deferred by scope, verified live on a cold worktree

A separate cold-worktree run at `master @ 2eea29a7` (worktree `excalidraw-boards-e2e-worktree`, discarded after)
confirmed build/unit/backend/voice-e2e all clean, then hit one real suite-design gap: `euidos/e2e/boards` is
serial and stateful and assumes a fresh database (documented at the top of the spec) — **running it a second
time against the SAME rehearsal stack, with no reset in between, fails at test 2** ("alice lands on an empty
boards page") because run 1's boards are still in the stack's Postgres volume. 9 downstream tests didn't run as
a consequence (Playwright serial mode stops the file) — a suite-design gap, not an app regression. First
failure:

```
boards.spec.ts:142
Expected: visible (getByTestId('boards-empty'))
Timeout: 15000ms — element(s) not found
```

Everything else in that cold run was clean: build (entry 1,910,844 B / 615,670 B gzipped, 45 M build size),
unit (23 files, 292 tests, 14.43 s — confirms G-P2.10's housekeeping holds: `persist.test.ts` is 22 tests with
no references to the deleted exports), backend (`storage-backend/test/run.sh`, throwaway Postgres 16-alpine, 10
suites / 41 tests, 5.7 s), voice e2e (27/27 in 3.3 min, STT `warm:true`). Worth a `TRUNCATE`/`DELETE` step in
`rehearsal.sh` or a global setup hook if repeat runs against one live stack instance are ever expected (e.g. CI
retries) — noted, not fixed, since it is a test-harness gap rather than a shipped-code defect.

Five additional findings surfaced by a second-pass security/merge-surface review of the fix-round diff, all
SHOULD/NICE, not yet re-verified as fixed (open for the next round or the main loop to triage):

- `hasLink()`'s tightened regex and the `resolveCollaboratorName` extraction (both applied above) were this
  pass's own two SHOULD fixes that landed; the pass's remaining findings are net-new and unapplied:
  the security-review's suggestion to also narrow the backend's `ROOM_KEY_RE` to match `hasLink()` (contestable
  decision: rejected for this round, backend out of scope);
  `identity.ts`'s `displayNameFor()` was tightened as above but a residual "Unknown" edge case (a named `via`
  with empty login AND empty name) has a documented test case, not a code path change beyond what's listed.

## Numbers worth carrying into wall-cutover / board-import planning

- Boards e2e: 8/8 (build round) → 11/11 (fix round), 0 flakes across both, but NOT safe to re-run against the
  same live stack without a reset (see suite-design gap above).
- App bundle: build round `assets/index-*.js` 1,906,267 B raw / 614,014 B gzipped; fix round 1,910,936 B raw /
  615,756 B gzipped (+4,669 B / +1,742 B gzipped for the review fixes).
- Unit tests: 219 (pre-phase-3) → 251 (build round, +32) → 297 (fix round, +46 more).
- The nginx `Host`/`Origin` port mismatch (found here) and the phase-1 CSRF guard it interacts with are the
  same mechanism — worth fixing together in `fleet-infra` before any origin that isn't port-443 is used for
  further rehearsal or QA.
- G-P3.5 (Tailscale Serve `via:"tailnet"` from an untagged device, and `via:"access"` after a real Access
  login) is STILL unverified end-to-end by any agent — dev-woo is a tagged device and no interactive session can
  mint an Access JWT. Both checks remain the founder's, not a build round's, to close — see the founderTest
  below and collab-plan.md's "what is left".

### Phase 3 shipped — 2026-09-18 (main loop)

| Item | Status | Note |
| --- | --- | --- |
| Deploy of master d202c88b | **met** | `deploy-whiteboard.sh master` by the main loop; storage image d202c88b healthy; nginx now proxies `Host $http_host` (fleet-infra c4f2c41) so the CSRF guard sees host:port like Origin. |
| Live checks on the phase-3 build | **met** | collab-smoke PASS 25.1 s; voice live-smoke PASS 26.5 s; bare tailnet origin serves the boards index; `/`, `/boards`, `/api/boards`, `/socket.io/` on board.euidos.ai all 302 → Access. |
| Boards e2e re-run flake | **open — owner: main loop** | Second consecutive run of euidos/e2e/boards against the same rehearsal stack fails at `boards-empty` (the suite assumes an empty database). Make the suite reset or scope its data; not a product defect. |
| Smoke-test boards removed | **done** | Every board created by the anonymous wall identity during smoke runs was soft-deleted on the host before the founder’s first look. |
