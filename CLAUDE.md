# CLAUDE.md — excalidraw-voice

Wrapper app around `@excalidraw/excalidraw` 0.18.1 (React 19, Vite 8, TypeScript strict, Node 22) that adds the
voice-area tool. Read `src/contracts.ts` first: it is the interface every module implements, and `App.tsx` only
wires them together.

Local-only repo (no git remote, no licence) at `/root/dev_workspaces/excalidraw-voice` on **dev-woo**, which is
also the build box. Run `npm install` once before `npm test` / `npm run build` / `npm run e2e`.

## Anatomy

| File | Contract it implements | One-liner |
| --- | --- | --- |
| `src/contracts.ts` | — | The interface. Types, defaults, JSDoc that defines behaviour. Do not edit to fit an implementation. |
| `src/contracts-capture.ts` | — | Round-2 interface (PCM ring buffer + energy VAD + utterance→stroke assignment). Declared, **not yet implemented**; see `REF-hate-round1.local.md`. |
| `src/stroke.ts` | `RecognizeStroke` | Pure geometry: points → line / rectangle / ellipse / null. No DOM, unit-tested. |
| `src/fit.ts` | `FitModule` | Builds placeholders and fits transcripts by binary-searching the largest font size that leaves the container's size unchanged, measured through the library's own `convertToExcalidrawElements` → `redrawTextBoundingBox`. |
| `src/audio.ts` | `CreateSegmentRecorder` | One `MediaRecorder` per segment over one long-lived `getUserMedia` stream; `cut()` closes a segment and opens the next; RMS level callback. |
| `src/stt.ts` | `Transcribe`, `CheckHealth` | `POST /v1/audio/transcriptions` (multipart, `verbose_json`) + `/health`; errors are typed `SttError` kinds. |
| `src/controller.ts` | `CreateVoiceController` | The state machine: arm/disarm, tool hijack, stroke capture, segment dispatch, placeholder animation, commit / fail / discard, retry. DOM-free. |
| `src/persist.ts` | — | Reads/writes the **vanilla** excalidraw-app storage so existing boards survive; debounced writes. |
| `src/settings.ts` | `VoiceSettings` | localStorage `voice-settings`, field-by-field coercion, subscriber fan-out. |
| `src/settings-panel.tsx` | — | React settings dialog (URL, language, prompt, mic, font caps, test button). |
| `src/toolbar.tsx` | `MountVoiceToolbarButton` | DOM injection of the mic + retry buttons into the library's own toolbar row; long-press (600 ms) opens settings. |
| `src/App.tsx` | — | Wiring only: creates the singletons once the imperative API exists, F9 key handling, `window.__excalidrawVoice` debug surface. |
| `src/voice.css` | — | Styles for the injected buttons and the panel, on Excalidraw's CSS variables. |
| `scripts/` | — | `copy-fonts.mjs` (prebuild), `deploy.sh`, `excalidraw-launcher.sh` (installed as `/usr/local/bin/excalidraw` on the whiteboard), `kiosk-probe.mjs` (CDP), `smoke.mjs`. |
| `test/unit`, `test/e2e` | — | vitest geometry tests; Playwright suite against the real STT server with Chromium's fake mic. |

## Invariants

- **`contracts.ts` is the interface.** Implement it exactly. A needed change is a design decision: raise it, do
  not quietly widen a signature.
- **Ids are stable placeholder → commit.** Every update hands back `newElementWith` copies of the caller's own
  elements, so ids and seeds survive and the version counter bumps once. `VoiceTarget` carries ids, never
  elements.
- **Never hold element objects across frames.** Look them up by id (`getSceneElementsIncludingDeleted`) at the
  moment you need them; a transcript can land after the user moved, edited or deleted the shape.
- **`onPointerUp` fires BEFORE the freedraw element is finalised.** Read the finished element one tick + one
  `requestAnimationFrame` later. Likewise the new element is inserted into the scene BEFORE `onPointerDown`
  fires, so the "before" id set must be snapshotted at arm time and refreshed after each capture — never at
  pointer-down.
- **`captureUpdate` rules.** `CaptureUpdateAction.IMMEDIATELY` for anything the user should be able to undo
  (creating the placeholder, committing text, marking failed, discarding); `NEVER` for cosmetic churn the user
  did not cause — placeholder animation frames, retry re-arming, tool restoration.
- **Fit probes carry fresh ids.** `redrawTextBoundingBox` caches grown heights by container id; probing with a
  real container's id poisons that cache and the editor snaps the container later.
- **A `custom` tool makes the canvas inert**, so stroke capture hijacks `freedraw`; when a native container tool
  (rectangle / ellipse / diamond / line) is already active, its element is used directly and the tool is left
  alone. Only restore a tool we switched ourselves.
- **Latch vs. hold.** F9 is hold (`pressStart`/`pressEnd`, window blur ends it); the button is latch
  (`toggleLatch`, ignored while holding). The wall panel has no keyboard — the latch path must always work.
- **No console noise** beyond `console.warn` on genuine failures.

## Verifying

```sh
npm install   # once per checkout; Node 22
npm test      # vitest, stroke geometry
npm run build # tsc --noEmit -p tsconfig.json + vite build (prebuild copies fonts)
npm run e2e   # Playwright; starts vite preview on 127.0.0.1:4173 itself
```

`npm run e2e` is the real-surface proof and is **not** mocked: real browser, Chromium fake mic fed with the WAVs
in `test/fixtures/`, and the real STT server at `http://100.81.33.83:8770`. If that server is down the suite is
meaningless — start it (logon scheduled task "STT server" on desktop-woo, the founder's own Windows desktop: sole
owner, no on-call, only they can power it on) and let it warm ~10 s first. Full outage runbook: README
"Troubleshooting"; host facts in `REF-hosts.local.md`. Gate screenshots go to `test-results/evidence/`.

For the deployed kiosk, tunnel CDP and run `scripts/kiosk-probe.mjs`. Both the whiteboard (`100.102.3.47`) and the
STT host are **tailnet-only**; deploying needs key-based `root@` SSH to the whiteboard from a box on the tailnet
(dev-woo has it), so plain `ssh` from anywhere else just fails.

## Never

- Do not change what the vanilla localStorage keys mean (`excalidraw`, `excalidraw-state`, `excalidraw-library`,
  `excalidraw-theme`, IndexedDB `files-db`): the founder's existing board lives there, and the wrapper must stay
  readable by (and compatible with) the plain app.
- Do not add npm dependencies casually. `idb-keyval`, `react`, `react-dom`, `@excalidraw/excalidraw` are what we
  have; anything else is a decision, not a convenience.
- Do not commit `dist/`, `public/fonts/`, `test-results/` or `playwright-report/` — all generated, all ignored.
- Do not edit another module's files, `contracts.ts`, `package.json` or configs when you own a module; ask.
- Do not claim a gate is met from a mocked run, a unit test, or a build that was never loaded in a browser.

## Casebook convention

Design, evidence and references for a cycle live in `.re0/iteration/<version>-<name>/` — here
`.re0/iteration/0.1.0-voice-areas/`: `DESIGN.local.md` (thesis, scope, quality gates G1–G8, settled contestable
decisions), `EVIDENCE.local.md` (one row per gate, only marked met with proof from the real surface),
`WORKFLOW.local.md` (how the round was run), `REF-*.local.md` (library internals, hosts, the round-1 hate pass).
Keep those files current as work lands; they, not chat scrollback, are the record.
