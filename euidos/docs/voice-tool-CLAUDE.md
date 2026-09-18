# voice-tool CLAUDE.md — the voice-area tool inside excalidraw-app

The spec for the **voice area** tool. It was built in 0.1.0 as a standalone wrapper app (`whiteboard/`) around the
published `@excalidraw/excalidraw` 0.18.1; in 0.2.0 phase 2 it was ported INTO the fork's own app and the wrapper
was retired. Everything below about behaviour, the contracts and the invariants is unchanged and still binding —
only the paths and the commands moved. Read `excalidraw-app/voice/contracts.ts` and
`excalidraw-app/voice/contracts-capture.ts` first: together they are the interface every module implements.

## Where things live now

| What | Path (from the fork root, `/root/dev_workspaces/excalidraw` on dev-woo) |
| --- | --- |
| The tool's modules | `excalidraw-app/voice/*.ts(x)` — the 0.1.0 `src/` files, same names |
| The wiring (was `src/App.tsx`) | `excalidraw-app/voice/VoiceTool.tsx` — one component, mounted as a sibling of `<Excalidraw>` in `excalidraw-app/App.tsx` |
| Unit tests (was `test/unit`) | `excalidraw-app/voice/__tests__/*.test.ts`, run by the monorepo's ROOT vitest (jsdom, not node) |
| e2e (was `test/e2e`) | `euidos/e2e/voice/` — spec, helpers, fixtures, its own `playwright.config.ts` and `package.json` |
| Kiosk probes (was `scripts/`) | `euidos/scripts/kiosk/` |
| Casebook (was `.re0/iteration/`) | `euidos/casebook/iteration/0.1.0-voice-areas/` |
| This file and the README | `euidos/docs/voice-tool-CLAUDE.md`, `euidos/docs/voice-tool-README.md` |

The app touches the tool in four places and nowhere else: `App.tsx` renders `<VoiceTool excalidrawAPI={…} />`,
imports `sweepGhostPlaceholders` for the local load path, `components/AppMainMenu.tsx` carries the
"Voice settings…" item, and `collab/Collab.tsx` sweeps the scene it loads from the room backend. Keep it that
way — the fork merges upstream, so every edited upstream line is a future conflict.

**What the port changed on purpose** (0.2.0 phase 2; the full list is the builder's API-drift note in
`euidos/casebook/iteration/0.2.0-collab/`):

- The app owns storage, so `persist.ts`'s vanilla-storage half (`createPersister` / `loadInitialData` /
  `libraryAdapter`) was never wired and was DELETED in phase 3 (G-P2.10): `excalidraw-app/data/LocalData.ts` +
  `data/euidosStorage.ts` + the app's own `useHandleLibrary` already own the vanilla keys and the room backend.
  `sweepGhostPlaceholders` is the module's only export, and it runs on BOTH load paths — local restore and the
  collab room load (phase-1 gate G-P2.2).
- The toolbar's DOM: master renders a tool as `button.ToolIcon[data-testid="toolbar-…"]`, not 0.18.1's
  `label.ToolIcon` around a hidden input. `toolbar.tsx` matches and injects buttons accordingly.
- No font copying: the app has its own woff2 pipeline and sets `EXCALIDRAW_ASSET_PATH` itself, so
  `scripts/copy-fonts.mjs` was NOT ported. `fit.warmFonts()` needs no build step.
- `appState.currentItemStrokeWidth` is gone on master; `snapshotStyle` reads
  `STROKE_WIDTH[appState.currentItemStrokeWidthKey]`.

## Verifying

Run everything from the fork root; it is a yarn 1.22.22 workspace (`corepack enable`).

```sh
yarn vitest run excalidraw-app/voice   # 194 unit tests (jsdom). NEVER run the whole upstream suite.
yarn test:typecheck                    # tsc over the monorepo
npx eslint --max-warnings=0 --ext .ts,.tsx excalidraw-app/voice
euidos/scripts/build-app.sh            # → excalidraw-app/build/
yarn start                             # dev server on :3000, /api proxied (see excalidraw-app/vite.config.mts)
```

The e2e suite runs against the BUILD, not the dev server, and against the REAL STT server:

```sh
euidos/scripts/build-app.sh
curl -sf http://100.81.33.83:8770/health          # must say warm:true FIRST — see below
cd euidos/e2e/voice && npm run e2e | tee test-results/last-run.txt
```

It serves `excalidraw-app/build` itself with `vite preview` on `127.0.0.1:4173` (`reuseExistingServer`), which is
also why the suite exercises the DIRECT STT URL: `contracts.defaultSttUrl` dials `100.81.33.83:8770` from a
loopback origin and `<origin>/stt` from anything else. `@playwright/test` resolves from `euidos/e2e/node_modules`
(one install for both suites); the Chromium build is the shared `~/.cache/ms-playwright` one.

### The live pass (the deployed origin, not a build on loopback)

The 27 gates never touch the hosted stack: on loopback the app dials STT directly, there is no `/api` backend and
no room. What only the deployment can prove — `getUserMedia` on the HTTPS origin, the multipart upload through
nginx's same-origin `/stt/` proxy (whose location block strips the identity headers), and that the words persist
through `/api/rooms/:id` while the scaffolding does NOT — is one script:

```sh
curl -sf https://euidos-internal.pony-bellatrix.ts.net/stt/health   # warm:true, or the run means nothing
cd euidos/e2e/voice && node live-smoke.mjs                          # default origin = the tailnet name
```

It opens a fresh `#room=` link, arms with F9 against Chromium's fake mic (`fixtures/en-short.wav`), draws a region,
waits for the words, then INJECTS the litter a crashed session leaves (marker + interim preview + placeholder),
waits until that has really reached the backend, and reopens the board cold: the words must be there and the
scaffolding must be gone. Run it after every deploy that touches `excalidraw-app/voice`, `collab/Collab.tsx` or
the nginx `/stt` block. `board.euidos.ai` is behind Cloudflare Access (302 to the login) and cannot be driven
headless — the tailnet origin is the one under test.

One ordering fact the script encodes, because it cost a debugging round: `Collab.initializeRoom()` calls
`resetScene()` and only then loads the room, so a take started before the room answers is wiped mid-flight and its
transcript is dropped. Never arm before `GET /api/rooms/:id` has come back.

### Running the kiosk scripts

`euidos/scripts/kiosk/*.mjs` import `@playwright/test`, and node resolves an ESM import against the FILE's path,
not the cwd — so they need `node_modules` reachable from `euidos/scripts/kiosk/`. Once per checkout:

```sh
ln -s ../../e2e/node_modules euidos/scripts/kiosk/node_modules   # or: cd euidos/scripts/kiosk && npm install
```

`deploy-static.sh` is the LEGACY wall-kiosk path and cannot run any more (it builds `whiteboard/dist`, which is
gone). The wall still serves its old static build off its own disk; **do not deploy to it, reload it or relaunch
it** — the cutover is deferred and needs the founder's go. The hosted board deploys with
`fleet-infra/scripts/deploy-whiteboard.sh <ref>`.

## The model, in one paragraph

Arming opens a session. Strokes produce **targets** (a region marker plus a placeholder text); the microphone
runs continuously and the VAD produces **utterances** (one speech burst bounded by silence); `assign.ts` maps
utterances onto strokes — the latest stroke whose pointer-down is ≤ onset + pre-roll (1.5 s) wins, so a label
spoken just before its box still lands in that box. A drawn shape is a REGION, not a drawing: the marker is dashed
scaffolding that the commit deletes, leaving the transcript alone on the canvas as a free text element fitted to
the region's bounding box. An assignment may only be acted on once it is `final` (the pre-roll window has
elapsed), several utterances may share one target (appended in onset order, refitted), and an
utterance no stroke can claim becomes free text at the last pointer position. Audio is cut by silence, never by
pointer events, so palm contacts and pans cut nothing. Never say "segment": the unit is an **utterance**.

**Transcription is independent of the region (round 5).** A take answers two questions that do not wait for each
other: WHAT was said — asked the instant the VAD closes the utterance, with the pen still down and the pre-roll
window still open — and WHERE it goes, which is still `assign.ts` gated by `final` and by the pen-down flush
barrier. `controller.ts settle()` is where they meet, called from both completion paths and idempotent, and it is
the only place a finished utterance is written to the canvas. While an utterance is still OPEN, `interimMs` slices
of it are transcribed and PREVIEWED in the region `assign()` would choose right now (provisional, not final): a
cosmetic `NEVER` update, stamped `customData.voiceInterim`, never a part, never `completed`, never toasted, and
reverted if the final assignment picks a different region. Measured on the real surface: pen-up → words went from
1874 ms (round 4) to 80 ms, with the ~1.6 s server round trip now paid while the founder is still drawing.

## Anatomy

| File | Contract it implements | One-liner |
| --- | --- | --- |
| `voice/contracts.ts` | — | Types, defaults, JSDoc that defines behaviour. Do not edit to fit an implementation. |
| `voice/contracts-capture.ts` | — | `VoiceCapture`, `AssignUtterance`, the VAD options and the hallucination blocklist. Every declaration here has a live implementation. |
| `voice/stroke.ts` | `RecognizeStroke` | Pure geometry: points → line / rectangle / ellipse / null. No DOM, unit-tested. Thresholds are the `RecognizeOptions` JSDoc defaults in `contracts.ts` plus `MIN_CHORD_PATH_RATIO` here — the source of truth the README only copies. |
| `voice/fit.ts` | `FitModule` | Builds region markers (dashed, stamped `customData.voiceRegion`, a rectangle on the stroke's bounding box for areas — one probe shape for placeholder and commit alike) with an animated placeholder, and fits transcripts by binary-searching the largest font size that leaves a throwaway probe container unchanged, measured through the library's own `convertToExcalidrawElements` → `redrawTextBoundingBox`. The commit copies that probe's layout onto a FREE text (containerId null, autoResize false at the fitted width) and marks the marker deleted. `markFailed` stamps `customData.voiceFailed` and refuses to overwrite landed words; `warmFonts()` is the font gate every measurement depends on. Line text wraps at the line-min floor instead of shrinking. |
| `voice/capture.ts` | `CreateVoiceCapture` | One long-lived `getUserMedia` stream → AudioWorklet (Blob-URL module) → Float32 ring buffer at 16 kHz; `wav(fromMs,toMs)` cuts a 16-bit mono WAV; mic transitions are pushed through `onMicChange`; `onLevel` and `noiseFloor` are RAW RMS (no display gain — that belongs to `level.ts`). |
| `voice/level.ts` | — | The display mappings for loudness, one function per axis: `meterPercent` (settings bar, full scale 0.06 = the VAD slider's range), `glyphLevel` (mic glyph, full scale 0.25, sqrt-compressed) and the effective VAD threshold (max(setting, 3× floor)). Imported by the panel and the toolbar so no surface invents its own gain. |
| `voice/vad.ts` | `Vad` (internal to capture) | Energy VAD as a pure state machine over 20 ms RMS frames; boundaries reported as sample indices; tracks the room's noise floor (kept across `reset()`), effective threshold = max(setting, 3× floor). |
| `voice/assign.ts` | `AssignUtterance` | Pure utterance→stroke rule plus `final`. Unit-tested; no timers, no scene. |
| `voice/stt.ts` | `Transcribe`, `CheckHealth` | `POST /v1/audio/transcriptions` (multipart, `verbose_json`) + `/health`; errors are typed `SttError` kinds. |
| `voice/controller.ts` | `CreateVoiceController` | The state machine: arm/disarm, tool hijack, stroke capture, utterance dispatch, placeholder animation, commit / fail / discard, orphans, retry. Round 5: `transcribeUtterance` (send at utterance end) and `runAssignment` (choose the region) both end at `settle`; `sendInterim`/`scheduleInterim`/`showInterim` drive the previews and `renderEntry` derives a region's appearance from its own state (parts → interim previews → placeholder), writing words with `IMMEDIATELY` only when they actually change. Round 5b: the pen-down barrier is per utterance, and a resolved utterance's WAV is released (only the `failed` map keeps audio). DOM-free. |
| `voice/persist.ts` | — | In THIS app only `sweepGhostPlaceholders` is wired (both load paths); the vanilla-storage half (`createPersister`, `loadInitialData`, `libraryAdapter`) was dead weight the app never called and was deleted in phase 3 (G-P2.10), so `sweepGhostPlaceholders` is now the only export. `sweepGhostPlaceholders` deletes the placeholders, the stamped ⚠ warnings (`customData.voiceFailed`, bound or not) AND the region markers a reload stranded (a finished take leaves no marker, so a stored marker is always litter), and only unbinds ghosts from containers that are not markers. Every deletion and every unbind goes through `newElementWith`, so it is a real versioned edit — see the reconciler invariant below. `SweepOptions.keepRecentMs` (`LIVE_SCAFFOLDING_MS`, 30 s) is passed by the COLLAB call site only: it spares a take whose scaffolding is still beating. |
| `voice/settings.ts` | `VoiceSettings` | localStorage `voice-settings`, field-by-field coercion, subscriber fan-out. `language` is coerced against `ALLOWED_LANGUAGES` (`ko`, `en`; "" = auto), so a stored `ja`/`zh` from before round 4b heals to auto instead of being posted to a server that answers it 400. |
| `voice/settings-panel.tsx` | — | React settings dialog: URL, language (auto/ko/en), prompt, mic, font caps, pre-roll, interim interval, VAD threshold over a live level meter, warm-mic, STT test. Also exports `voiceSettingsIcon`, the glyph for the main-menu entry that opens it. |
| `voice/toolbar.tsx` | `MountVoiceToolbarButton` | DOM injection into the library's own toolbar row: a mic-glyph button (`data-testid="toolbar-voice"`, aria-label "Voice area", F9 keybinding label) placed after the last native tool, plus a retry button right of it that stays hidden until something has failed; a tap of any length latches. The glyph IS the level meter: `buttonVisualState` (pure, unit-tested) maps the status to `--voice-level` through `level.ts` plus the `voice-tool--armed/--recording/--speaking/--mic-missing` classes, and voice.css clips the capsule's fill to that level. |
| `voice/VoiceTool.tsx` | — | Wiring only: singletons once the imperative API exists, F9 handling, the settings panel, `window.__excalidrawVoice`. Also exports `VoiceSettingsMenuItem`, the whole of the main-menu entry, so upstream's `AppMainMenu.tsx` costs one import and one element. |
| `voice/index.ts` | — | The public surface, and the ONLY path upstream files import (`sweepGhostPlaceholders`, `VoiceTool`, `VoiceSettingsMenuItem`, `isVoiceEnabled`). One import line per touchpoint = one conflict hunk per touchpoint on a rebase. `collab/Collab.tsx` reaches `../voice/persist` directly: it wants the pure sweep and has no business pulling React in. |
| `voice/enabled.ts` | — | `isVoiceEnabled()` — the fork's kill switch, `VITE_APP_ENABLE_VOICE`. FAIL-OPEN: only the literal `"false"` turns the tool off, so the e2e, the kiosk build and `yarn start` are unaffected. It gates both the mount and the menu item. |
| `voice/voice.css` | — | Styles for the injected buttons, the mic glyph's level fill/ring (22 px: the library forces 16 px on toolbar SVGs), the panel (top-LEFT, under the main menu, offset clear of the shape-properties island) and the level meter. Every library variable used by the PANEL carries a literal fallback, because the panel renders outside the `.excalidraw` subtree where `--color-*` do not exist. |
| `euidos/scripts/kiosk/` | — | `deploy-static.sh` (LEGACY), `excalidraw-launcher.sh` (installed as `/usr/local/bin/excalidraw` on the whiteboard), `smoke.mjs`, and the CDP kiosk probes `kiosk-probe.mjs` / `kiosk-mic-check.mjs` / `kiosk-blob-check.mjs` / `kiosk-offset-check.mjs`, and `stt-abort-check.mjs` (round 5: fires a real Chromium fetch at the STT server and aborts it while it is queued, then checks `/health.skipped` — the proof that an abandoned interim slice costs no GPU time). |
| `voice/__tests__`, `euidos/e2e/voice` | — | vitest: stroke, vad, assign, capture, controller, fit, persist, collab-sweep, enabled, settings, stt, hallucination, level, toolbar (`fit` and `controller` run against a faked library — the real numbers are the browser's job; `collab-sweep` runs the REAL `reconcileElements`). Playwright against the real STT server with Chromium's fake mic. |

## Invariants

- **The contracts are the interface.** Implement them exactly, including the stated unit, error channel and owner
  of each mutable quantity. A needed change is a design decision: raise it, do not quietly widen a signature.
- **Failure is a channel, not a field.** Every boundary that can fail returns a typed result or fires its
  callback (`onMicChange`, `SttError`); no caller learns about failure by reading a callee's field. A mic that is
  not working refuses the arm and shows up in `status.lastError`.
- **Gesture constants are SCREEN px, geometry is scene px.** Anything derived from a human gesture (tap floor,
  vertical-line width) is divided by `appState.zoom.value` at the call site.
- **Interaction-scoped identity.** "The element this stroke made" comes from the interaction
  (`appState.newElement` at pointer-down, with a per-stroke id diff as fallback), never from "the element that is
  new in the scene" — undo, paste or a remote insert while armed must not be converted.
- **Deferred work has a flush barrier, and the barrier is PER UTTERANCE.** `onPointerUp → 30 ms → rAF →
  captureStroke` is a named unit that any event which could invalidate it (next pointer-down, disarm) runs
  synchronously first. An assignment must also wait for it (gate N2e), but only for the strokes that could still
  change ITS answer: `assign.ts` can only give an utterance to a stroke whose pointer-down is ≤ `onsetMs + preRoll`,
  so `runAssignment` waits on `currentStroke` / `Session.pendingDowns` (the queued conversions' pointer-down times,
  which is why they are times and not a count) only when one of them falls inside that window. A session-wide
  barrier made words that no open stroke could claim wait out the whole of the NEXT stroke — the largest remaining
  pen-up → words latency once round 5 had moved the round trip off that path (round 5b).
- **Ids are stable placeholder → commit.** Updates hand back `newElementWith` copies of the caller's own
  elements, so ids and seeds survive and the version counter bumps once. `VoiceTarget` carries ids, never
  elements.
- **Never hold element objects across frames.** Look them up by id (`getSceneElementsIncludingDeleted`) when you
  need them; a transcript can land after the user moved, edited or deleted the shape.
- **The scene is SHARED: a delete has to win a reconcile, not just stop being drawn.** In 0.1.0 the only reader of
  a deletion was the same browser. Now `reconcileElements` decides between our copy and a peer's, and it breaks a
  version tie on `local.versionNonce <= remote.versionNonce` — so a shallow `{ ...el, isDeleted: true }` (same
  version, same nonce) is discarded by every peer still holding the element alive, and `getSceneVersion` (a plain
  sum of versions) does not even rise, so Collab never broadcasts it and `isSavedToFirebase` calls the scene
  already saved. A preserved `updated` is worse again: `isSyncableElement` strips tombstones older than 24 h out of
  the PUT entirely. Every scene write in this tool therefore goes through `newElementWith`, the sweep included, and
  `Collab.initializeRoom` takes its broadcast watermark from the PRE-sweep array so the sweep counts as a local
  change. Gates: `voice/__tests__/collab-sweep.test.ts`, which runs the real reconciler in both argument orders.
- **The sweep may not delete a take someone is still speaking into.** The stamps cannot tell a dead ghost from a
  live one, and with the bump above a wrong delete actually propagates: the speaker's controller then finds its
  text gone and takes the "the user deleted the shape while we were transcribing" branch, dropping the sentence
  with no ⚠ and no toast. `element.updated` is the heartbeat (the placeholder animates ~3x/s, the interim preview
  is rewritten every slice) and `keepRecentMs` is the rule, grouped by marker so a long utterance's untouched
  marker is kept alive by its ticking placeholder. The LOCAL load path passes nothing and sweeps everything —
  there, this browser is the only client that could have been speaking, and it just reloaded.
- **`dispose()` owns the canvas it drew on, but a tab CLOSE does not reach it.** Disposing runs the same sweep
  over the live scene (`CaptureUpdateAction.NEVER` — a teardown is not the founder's undo checkpoint), so a clean
  unmount leaves nothing behind. A real tab close is NOT winnable: `Collab` registers its `beforeunload` in its
  constructor, before this component exists, and clones the scene synchronously there, so no later listener can
  clean up first — and that handler deliberately saves the room on the way out. That case is the load-path
  sweep's job, which is the reason the tombstones it writes must be broadcastable.
- **The drawn shape is a region marker, not a drawing.** Every marker carries `customData.voiceRegion` (it
  survives storage) and is deleted the moment the text lands — including a shape the founder drew with a native tool
  while armed. Only a FAILED take keeps its marker, dashed, so the retry button has a visible target.
- **A region is deleted by a COMMIT, or by the disarm — never mid-take.** A region nobody spoke into stays exactly
  where the founder drew it until the session ends, and the disarm then sweeps all of them in ONE undoable update
  with a toast that counts them. Closing a region early (`isSuperseded`) only stops speech landing in it; round 4a
  wired closing straight to deleting, which erased every box drawn before the first spoken label while latched.
- **Landed words are the only copy there is — but an interim preview is not landed words.** Nothing may overwrite a
  committed transcript to report something: `fit.markFailed` returns `[]` when the text already carries words, and a
  failure is reported through the toast, `status.failed` and the retry button instead. A `voiceInterim`-stamped text
  is explicitly NOT such a copy (round 5b): it is this take's own guess, `persist.ts` deletes it on the next reload,
  and the take it belongs to is the one that just failed — so the ⚠ replaces it. Before that, a final transcript
  that failed after a preview had landed was reported NOWHERE and the region kept half a sentence at 45 % for ever
  (the entry is `failed`, so no later render, no animation tick and no disarm sweep touches it again). A ⚠ warning carries `customData.voiceFailed` so `persist.ts` can
  sweep it without reading text content — and a commit CLEARS that stamp, or a reload would eat the transcript.
- **The region's geometry lives in the target, not in an element.** `VoiceTarget.shape` is what a commit fits
  into, because by the second utterance (or a retry) the marker is already gone. `findTarget` treats a missing
  marker as normal; only the text element must be alive.
- **The user's geometry is the user's.** Fitting shrinks text to the region the founder drew; it never resizes
  anything. Below the floor font size the text simply stays at the floor (a region too small for it is the
  founder's choice, and the words stay legible).
- **Transcription never waits for the pen, and the canvas never shows a preview it cannot take back.** The STT
  request leaves at `onUtteranceEnd`; only the WRITING waits for `final` + the flush barrier, in `settle()`, which
  must stay idempotent because either half may arrive second (a retry clears `settled` on purpose: it is a new
  take). Interim previews are **cosmetic**: `CaptureUpdateAction.NEVER`, stamped `customData.voiceInterim`, swept by
  `persist.ts` on reload, never counted in `completed`/`dropped`, and never allowed over a committed transcript, a ⚠
  warning or a closed region. A target's appearance is a pure function of its own state (`renderEntry`: parts →
  interim texts pointing at it → placeholder), so "undo the preview in the region the pre-roll changed its mind
  about" is just "render that region again" — not a per-transition patch, which is how a round-4 predicate ended up
  deleting regions it was never about.
- **Only one interim slice per utterance is ever in flight, and the cadence is measured from the last ANSWER.** The
  measured round trip (~1.6 s over the tailnet) is longer than the 1200 ms default, so a timer that fired regardless
  aborted every slice with its own successor and no preview ever appeared. On the server side an abandoned slice must
  cost nothing: the GPU lock is an `asyncio.Lock` held in the handler and `request.is_disconnected()` is checked
  after acquiring it, so an aborted request is answered 499 and the FINAL take does not queue behind it.
- **A region deleted DURING a take and a region that was already gone are different answers.** The founder deleting
  a pending region is their decision (drop silently, gate G5c); an utterance whose stroke record is stale was never
  in that region and its words fall through to the orphan path (gate N2d). Since round 5 resolves the target after
  the request returns, `UtteranceEntry.liveTargets` (the regions alive when the audio was sent, kept current by
  `noteLiveTarget` as later conversions produce their regions — in the speak-while-drawing gesture the owning region
  does not exist yet when the audio goes out) is what tells the two apart. The answer may not depend on bookkeeping
  that PRUNING can take away (round 5b): `renderEntry` calls `forgetStroke` whenever a preview outlives its region,
  which removes the entry and its stroke record and makes the assignment itself come back null, so `settle` asks the
  question of the ids the take recorded for itself — the region it was assigned to and the regions it previewed in
  (`previewTargets`, the boxes the founder watched these words appear in) — plus the scene. Deliberately not "any
  region that was alive when the audio was sent": tidying up an unrelated older transcript must not eat the sentence
  being spoken now.
- **`captureUpdate` rules.** `CaptureUpdateAction.IMMEDIATELY` for anything the user should be able to undo
  (creating the placeholder, committing text, marking failed, discarding); `NEVER` for cosmetic churn the user
  did not cause — placeholder animation frames, retry re-arming, tool restoration, **and the marker's deletion at
  commit** (which is why the commit is two updates: the words IMMEDIATELY, then the scaffolding with NEVER. One
  Ctrl+Z after a commit used to resurrect the dashed box as a live, ownerless region).
- **Fit probes carry fresh ids.** `redrawTextBoundingBox` caches grown heights by container id; probing with a
  real container's id poisons that cache and the editor snaps the container later. Only the probe's LAYOUT is
  kept: the committed text is unbound, so nothing on the canvas can be re-laid-out against a container again.
- **A `custom` tool makes the canvas inert**, so stroke capture hijacks `freedraw`; when a native container tool
  (rectangle / ellipse / diamond / line) is already active, its element is used directly and the tool is left
  alone. Only restore a tool we switched ourselves.
- **Latch vs. hold.** F9 is hold (`pressStart`/`pressEnd`, window blur ends it); the toolbar button is latch
  (`toggleLatch`, any tap length, ignored while holding). The wall panel has no keyboard — the latch path must
  always work, and no gesture on that button may open settings (`ToolbarOptions` has no settings hook at all since
  round 4c; settings are a main-menu item). The panel itself closes on Escape and on a tap outside it.
- **Rendering a `<MainMenu>` REPLACES the library's fallback one.** In the wrapper that meant App.tsx had to
  reproduce LayerUI's `DefaultMainMenu` item for item; in this app `excalidraw-app/components/AppMainMenu.tsx`
  already discharges it and the voice entry is ONE item added to that list. The hazard is unchanged: an item
  deleted from that composition disappears from the founder's board with no error, so the e2e asserts the testids
  of the rows the founder has (the theme row is the app's light/dark/system radio, not `toggle-dark-mode`).
- **`recording` is "the stream is open"; `speaking` is "the VAD kept this".** The mic glyph draws both, and only
  `speaking` may use the accent colour — a level that fills but never turns green is a VAD threshold to adjust, and
  conflating the two would hide exactly that. `speaking` is false whenever `mode === "idle"`, by construction.
- **A dropped transcript is counted AND rendered.** Empty results and blocklist hits leave no ⚠ and no retry, so
  they are counted in `status.dropped` / `lastDropped` *and* shown: a toast at the moment of the drop
  (`Filtered: "…"` / `No speech heard for that shape`, 2.5 s) plus `dropped N` in the mic button's tooltip. A
  status field with no rendered sink is a private field with extra steps (RETRO L2).
- **One number, one scale.** A quantity crossing a module boundary carries the unit the owner measures in — the
  capture emits raw RMS, never a pre-gained copy — and the surface that draws it applies its own display gain
  through `level.ts`. Two numbers on one axis are drawn by one function (RETRO L6). `level.ts` owns exactly two
  axes and one function each: `meterPercent` for the settings bar (full scale 0.06, the VAD slider's range) and
  `glyphLevel` for the mic glyph (full scale 0.25, sqrt-compressed, because measured speech is 0.08..0.48 and on the
  meter's axis the glyph sat pinned at 100% and strobed at word boundaries).
- **Fitting waits for the fonts.** Text metrics are font metrics, and the library only loads its webfont once text
  is first MEASURED — so `document.fonts.ready` on its own resolves too early. `fit.warmFonts()` measures once and
  then awaits; App calls it at boot and the controller awaits it before it arms, so no take can be fitted against
  fallback metrics. A test may not substitute its own font warm-up for that gate.
- **No console noise** beyond `console.warn` on genuine failures.

## The STT server, and what a red e2e run means

The e2e suite is the real-surface proof and is **not** mocked: real browser, Chromium fake mic fed with the WAVs
in `euidos/e2e/voice/fixtures/`, real STT at `http://100.81.33.83:8770`. The suite never probes `/health`, so its
exit code does not distinguish "this app regressed" from "the server was down": `curl -sf
http://100.81.33.83:8770/health` **before** the run and record that in the evidence row. With the server down the
geometry and failure-path gates still pass while every transcript gate fails, so the run goes red for the wrong
reason; green is only reachable with the server answering. Start it (logon scheduled task "STT server" on
desktop-woo, the founder's own Windows desktop: sole owner, no on-call, only they can power it on) and let it warm
~10 s. Outage runbook: `voice-tool-README.md` "Troubleshooting"; host facts in
`euidos/casebook/iteration/0.1.0-voice-areas/REF-hosts.local.md`. Gate screenshots go to
`euidos/e2e/voice/test-results/evidence/`, the run log to `test-results/last-run.txt` — the path a report cites
must exist before any status is marked met, and a flake is a failure.

Which URL is exercised depends on the origin, by design (`contracts.defaultSttUrl`): a loopback origin (the e2e's
`127.0.0.1:4173`, the kiosk's `127.0.0.1:8765`) dials `100.81.33.83:8770` DIRECTLY; every other origin posts to
`<origin>/stt`, which euidos-internal's nginx proxies — with the identity headers stripped, so the multipart
upload carries no `Cookie`/`Tailscale-User-*`. Both branches are live and both were measured in 0.2.0 phase 2.

For the deployed kiosk, tunnel CDP (`ssh -f -N -L 9223:127.0.0.1:9222 root@100.102.3.47`) and run the probes in
`euidos/scripts/kiosk/`. Both the whiteboard (`100.102.3.47`) and the STT host are **tailnet-only**, so plain
`ssh` from off the tailnet just fails. **The wall kiosk still runs the pre-port static build off its own disk and
is frozen until the founder approves the cutover** — read from it, never write to it.

## Never

- Do not change what the vanilla localStorage keys mean (`excalidraw`, `excalidraw-state`, `excalidraw-library`,
  `excalidraw-theme`, IndexedDB `files-db`): the founder's existing board lives there. In this app they belong to
  `excalidraw-app/data/LocalData.ts`, not to the voice tool — `persist.ts` must not write them.
- Do not add npm dependencies. The voice tool imports only what excalidraw-app already depends on (`react`,
  `idb-keyval`, the workspace packages); anything else is a decision, not a convenience.
- Do not spread the tool through upstream files. Four touchpoints (`App.tsx`, `components/AppMainMenu.tsx`,
  `collab/Collab.tsx`, and `voice/` itself); a fifth is a merge conflict the fork will pay for.
- Do not mutate the founder's live board from a probe. On 2026-09-18 a probe's "cleanup" (`kiosk-clear.mjs`, now
  deleted from the repo) wiped 785 elements the founder had drawn that morning; they came back only because the
  page still held them as `isDeleted` (`euidos/scripts/kiosk/kiosk-restore.mjs`). A probe may add its own stroke — with no
  speech the disarm sweep removes it — and may delete only elements it created, by id. Never a scene-wide update,
  and never `kiosk-reload.mjs --force` while `kiosk-reload.mjs` reports the board in use.
- Do not commit `excalidraw-app/build/`, `test-results/` or `playwright-report/` — all generated, all ignored.
- Do not edit another module's files, the contracts, `package.json` or configs when you own a module; ask.
- Do not leave a module in `voice/` that nothing imports, or a contract nothing implements; two contradicting
  contracts is how round 1 shipped the wrong segmenter.
- Do not delete a shared-scene element with a shallow `{ ...el, isDeleted: true }`. See the reconciler invariant.
- Do not claim a gate is met from a mocked run, a unit test, a build that was never loaded in a browser, or a
  parameter chosen from a builder's report instead of the declared operating envelope.

## Casebook convention

Design, evidence and references for a cycle live in `euidos/casebook/iteration/<version>-<name>/` — for this tool
`euidos/casebook/iteration/0.1.0-voice-areas/` (the port itself is `0.2.0-collab/`): `DESIGN.local.md` (thesis, scope, gates G1–G8, the round-2 changes R1–R7 and
the round-4 gates G9–G12), `EVIDENCE.local.md` (one row per gate, met only with proof from the real surface, plus
the **open-rows table** that is the actual backlog), `RETRO.local.md` (lessons L1–L21 and the next-cycle gates,
currently N9, N13, N15–N22 — N2e closed round 4c), `WORKFLOW.local.md` (how each round was run, incl. which model
class did which stage), `REF-*.local.md` (library internals, hosts, the round-1 hate pass). Every decision and
every declared risk exits a cycle as a gate row with a proof path or an explicit "accepted, not tested" line —
and an accepted line needs a named owner and the round it is re-decided in, because round 3 spent its whole
budget on rows that had sat "accepted" since round 2 (RETRO L9/N14). Start a round by reading the open-rows
table, not the gate list. Those files, not chat scrollback, are the record.
