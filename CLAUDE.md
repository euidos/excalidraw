# CLAUDE.md — excalidraw-voice

Wrapper app around `@excalidraw/excalidraw` 0.18.1 (React 19, Vite 8, TypeScript strict, Node 22) that adds the
voice-area tool. Read `src/contracts.ts` and `src/contracts-capture.ts` first: together they are the interface
every module implements, and `App.tsx` only wires them together.

Local-only repo (no git remote, no licence) at `/root/dev_workspaces/excalidraw-voice` on **dev-woo**, which is
also the build box. Run `npm install` once before `npm test` / `npm run build` / `npm run e2e`.

## The model, in one paragraph

Arming opens a session. Strokes produce **targets** (a container plus a bound placeholder text); the microphone
runs continuously and the VAD produces **utterances** (one speech burst bounded by silence); `assign.ts` maps
utterances onto strokes — the latest stroke whose pointer-down is ≤ onset + pre-roll (1.5 s) wins, so a label
spoken just before its box still lands in that box. An assignment may only be acted on once it is `final` (the
pre-roll window has elapsed), several utterances may share one target (appended in onset order, refitted), and an
utterance no stroke can claim becomes free text at the last pointer position. Audio is cut by silence, never by
pointer events, so palm contacts and pans cut nothing. Never say "segment": the unit is an **utterance**.

## Anatomy

| File | Contract it implements | One-liner |
| --- | --- | --- |
| `src/contracts.ts` | — | Types, defaults, JSDoc that defines behaviour. Do not edit to fit an implementation. |
| `src/contracts-capture.ts` | — | `VoiceCapture`, `AssignUtterance`, the VAD options and the hallucination blocklist. Every declaration here has a live implementation. |
| `src/stroke.ts` | `RecognizeStroke` | Pure geometry: points → line / rectangle / ellipse / null. No DOM, unit-tested. Thresholds are the `RecognizeOptions` JSDoc defaults in `contracts.ts` plus `MIN_CHORD_PATH_RATIO` here — the source of truth the README only copies. |
| `src/fit.ts` | `FitModule` | Builds placeholders and fits transcripts by binary-searching the largest font size that leaves the container's size unchanged, measured through the library's own `convertToExcalidrawElements` → `redrawTextBoundingBox`. Line text wraps at the line-min floor instead of shrinking. |
| `src/capture.ts` | `CreateVoiceCapture` | One long-lived `getUserMedia` stream → AudioWorklet (Blob-URL module) → Float32 ring buffer at 16 kHz; `wav(fromMs,toMs)` cuts a 16-bit mono WAV; mic transitions are pushed through `onMicChange`; `onLevel` and `noiseFloor` are RAW RMS (no display gain — that belongs to `level.ts`). |
| `src/level.ts` | — | The ONE display mapping for loudness: raw RMS → meter %, plus the effective VAD threshold (max(setting, 3× floor)). Imported by the panel and the toolbar so a bar and a marker can never end up on two axes. |
| `src/vad.ts` | `Vad` (internal to capture) | Energy VAD as a pure state machine over 20 ms RMS frames; boundaries reported as sample indices; tracks the room's noise floor (kept across `reset()`), effective threshold = max(setting, 3× floor). |
| `src/assign.ts` | `AssignUtterance` | Pure utterance→stroke rule plus `final`. Unit-tested; no timers, no scene. |
| `src/stt.ts` | `Transcribe`, `CheckHealth` | `POST /v1/audio/transcriptions` (multipart, `verbose_json`) + `/health`; errors are typed `SttError` kinds. |
| `src/controller.ts` | `CreateVoiceController` | The state machine: arm/disarm, tool hijack, stroke capture, utterance dispatch, placeholder animation, commit / fail / discard, orphans, retry. DOM-free. |
| `src/persist.ts` | — | Reads/writes the **vanilla** excalidraw-app storage so existing boards survive; debounced writes; `sweepGhostPlaceholders` cleans placeholders a reload stranded. |
| `src/settings.ts` | `VoiceSettings` | localStorage `voice-settings`, field-by-field coercion, subscriber fan-out. |
| `src/settings-panel.tsx` | — | React settings dialog: URL, language, prompt, mic, font caps, pre-roll, VAD threshold over a live level meter, warm-mic, STT test. |
| `src/toolbar.tsx` | `MountVoiceToolbarButton` | DOM injection into the library's own toolbar row: a mic-glyph button (`data-testid="toolbar-voice"`, aria-label "Voice area", F9 keybinding label) placed after the last native tool, plus a retry button right of it that stays hidden until something has failed; a tap of any length latches. |
| `src/App.tsx` | — | Wiring only: singletons once the imperative API exists, F9 handling, the top-right settings gear, `window.__excalidrawVoice`. |
| `src/voice.css` | — | Styles for the injected buttons, the panel and the level meter, on Excalidraw's CSS variables. |
| `scripts/` | — | `copy-fonts.mjs` (prebuild), `deploy.sh`, `excalidraw-launcher.sh` (installed as `/usr/local/bin/excalidraw` on the whiteboard), `smoke.mjs`, and the CDP kiosk probes `kiosk-probe.mjs` / `kiosk-mic-check.mjs` / `kiosk-blob-check.mjs` / `kiosk-offset-check.mjs` / `kiosk-clear.mjs` (README "Probing the live kiosk" says which answers what). |
| `test/unit`, `test/e2e` | — | vitest: stroke, vad, assign, capture, controller, persist, stt, hallucination, level, toolbar. Playwright against the real STT server with Chromium's fake mic. |

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
- **Deferred work has a flush barrier.** `onPointerUp → 30 ms → rAF → captureStroke` is a named unit that any
  event which could invalidate it (next pointer-down, disarm) runs synchronously first.
- **Ids are stable placeholder → commit.** Updates hand back `newElementWith` copies of the caller's own
  elements, so ids and seeds survive and the version counter bumps once. `VoiceTarget` carries ids, never
  elements.
- **Never hold element objects across frames.** Look them up by id (`getSceneElementsIncludingDeleted`) when you
  need them; a transcript can land after the user moved, edited or deleted the shape.
- **The user's geometry is the user's.** Fitting shrinks text, it does not resize the drawn shape; the one
  documented exception (a shape too small for the floor font size) is visible — the placeholder turns solid and
  the growth happens where the founder can see it.
- **`captureUpdate` rules.** `CaptureUpdateAction.IMMEDIATELY` for anything the user should be able to undo
  (creating the placeholder, committing text, marking failed, discarding); `NEVER` for cosmetic churn the user
  did not cause — placeholder animation frames, retry re-arming, tool restoration.
- **Fit probes carry fresh ids.** `redrawTextBoundingBox` caches grown heights by container id; probing with a
  real container's id poisons that cache and the editor snaps the container later.
- **A `custom` tool makes the canvas inert**, so stroke capture hijacks `freedraw`; when a native container tool
  (rectangle / ellipse / diamond / line) is already active, its element is used directly and the tool is left
  alone. Only restore a tool we switched ourselves.
- **Latch vs. hold.** F9 is hold (`pressStart`/`pressEnd`, window blur ends it); the toolbar button is latch
  (`toggleLatch`, any tap length, ignored while holding). The wall panel has no keyboard — the latch path must
  always work, and no gesture on that button may open settings.
- **A dropped transcript is counted AND rendered.** Empty results and blocklist hits leave no ⚠ and no retry, so
  they are counted in `status.dropped` / `lastDropped` *and* shown: a toast at the moment of the drop
  (`Filtered: "…"` / `No speech heard for that shape`, 2.5 s) plus `dropped N` in the mic button's tooltip. A
  status field with no rendered sink is a private field with extra steps (RETRO L2).
- **One number, one scale.** A quantity crossing a module boundary carries the unit the owner measures in — the
  capture emits raw RMS, never a pre-gained copy — and the surface that draws it applies its own display gain
  through `level.ts`. Two numbers on one axis are drawn by one function (RETRO L6).
- **No console noise** beyond `console.warn` on genuine failures.

## Verifying

```sh
npm install   # once per checkout; Node 22
npm test      # vitest: stroke, vad, assign, capture, controller, persist, stt, hallucination, level, toolbar
npm run build # tsc --noEmit -p tsconfig.json + vite build (prebuild copies fonts)
npm run e2e   # Playwright; starts vite preview on 127.0.0.1:4173 itself; retries: 0
```

`npm run e2e` is the real-surface proof and is **not** mocked: real browser, Chromium fake mic fed with the WAVs
in `test/fixtures/`, real STT at `http://100.81.33.83:8770`. The suite never probes `/health`, so its exit code
does not distinguish "this app regressed" from "the server was down": `curl -sf http://100.81.33.83:8770/health`
**before** the run and record that in the evidence row. With the server down the geometry and failure-path gates
still pass while every transcript gate fails, so the run goes red for the wrong reason; green is only reachable
with the server answering. Start it (logon scheduled task "STT server" on desktop-woo, the founder's own Windows
desktop: sole owner, no on-call, only they can power it on) and let it warm ~10 s. Outage runbook: README
"Troubleshooting"; host facts in `REF-hosts.local.md`. Gate screenshots go to `test-results/evidence/`, the run log to
`test-results/last-run.txt` — the path a report cites must exist before any status is marked met, and a flake is
a failure.

For the deployed kiosk, tunnel CDP (`ssh -f -N -L 9223:127.0.0.1:9222 root@100.102.3.47`) and run the probes in
`scripts/`. Both the whiteboard (`100.102.3.47`) and the STT host are **tailnet-only**; deploying needs key-based
`root@` SSH to the whiteboard from a box on the tailnet (dev-woo has it), so plain `ssh` elsewhere just fails.

`scripts/deploy.sh` is not atomic and has **no rollback**: `rsync --delete` replaces the served directory in
place and the whiteboard keeps no previous build, so going back means rebuilding an older commit on dev-woo (or
restoring a copy you took first). File server (`excalidraw.service`) and kiosk (`excalidraw-ui.service`) are
separate units and fail separately — the recovery steps, the status/journal commands and the rollback recipe are
README "If a deploy breaks the kiosk". A deploy or rollback never touches the founder's board: it lives in the
browser profile's storage for `http://127.0.0.1:8765`, not in `dist/`.

## Never

- Do not change what the vanilla localStorage keys mean (`excalidraw`, `excalidraw-state`, `excalidraw-library`,
  `excalidraw-theme`, IndexedDB `files-db`): the founder's existing board lives there, and the wrapper must stay
  readable by (and compatible with) the plain app.
- Do not add npm dependencies casually. `idb-keyval`, `react`, `react-dom`, `@excalidraw/excalidraw` are what we
  have; anything else is a decision, not a convenience.
- Do not run `scripts/kiosk-clear.mjs` unasked — it deletes every element on the founder's live board.
- Do not commit `dist/`, `public/fonts/`, `test-results/` or `playwright-report/` — all generated, all ignored.
- Do not edit another module's files, the contracts, `package.json` or configs when you own a module; ask.
- Do not leave a module in `src/` that nothing imports, or a contract nothing implements; two contradicting
  contracts in `src/` is how round 1 shipped the wrong segmenter.
- Do not claim a gate is met from a mocked run, a unit test, a build that was never loaded in a browser, or a
  parameter chosen from a builder's report instead of the declared operating envelope.

## Casebook convention

Design, evidence and references for a cycle live in `.re0/iteration/<version>-<name>/` — here
`.re0/iteration/0.1.0-voice-areas/`: `DESIGN.local.md` (thesis, scope, gates G1–G8 and the round-2 changes
R1–R7), `EVIDENCE.local.md` (one row per gate, met only with proof from the real surface, plus the **open-rows
table** that is the actual backlog), `RETRO.local.md` (lessons L1–L9 and the next-cycle gates, currently N2e, N9,
N13, N14), `WORKFLOW.local.md` (how the round was run), `REF-*.local.md` (library internals, hosts, the round-1
hate pass). Every decision and every declared risk exits a cycle as a gate row with a proof path or an explicit
"accepted, not tested" line — and an accepted line needs a named owner and the round it is re-decided in, because
round 3 spent its whole budget on rows that had sat "accepted" since round 2 (RETRO L9/N14). Start a round by
reading the open-rows table, not the gate list. Those files, not chat scrollback, are the record.
