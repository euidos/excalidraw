# excalidraw-voice

A wrapper around `@excalidraw/excalidraw` that adds one tool: **voice area**. While the tool is armed the
microphone records, and every stroke you draw is recognised as a line, oval or box and immediately replaced by a
real Excalidraw shape holding an animated placeholder; the audio belonging to that shape is sent to the local
speech-to-text server as soon as the next stroke starts (or the hold ends), and the transcript is fitted into the
shape at the largest font size that still fits when it comes back. Strokes never wait for transcripts — several
can be in flight at once, and results land by element id in whatever order they arrive.

**Repo:** this is a local-only git repo on **dev-woo** at `/root/dev_workspaces/excalidraw-voice`. There is no
git remote and nothing to clone from a forge: get onto dev-woo (`ssh dev-woo` over the tailnet, key-based root)
and work in that directory. Private, unpublished, no licence file — treat it as the founder's code.

**The whiteboard** is a wall-mounted touch display in the founder's office driven by a small Ubuntu 24.04 PC
(tailnet `100.102.3.47`), which boots straight into Chromium kiosk mode showing a locally served Excalidraw. That
kiosk previously ran plain Excalidraw; this app replaces the static bundle it serves. Because it reads and writes
the **vanilla** excalidraw-app storage keys on the same origin (`http://127.0.0.1:8765`), the founder's existing
drawings, app state, library and images carry over untouched — no import step. On a fresh machine, a new browser
profile, or any other origin there is simply no such storage, and the app opens an empty board with defaults;
that is the normal fresh-install path, not an error.

## Setup

Node 22 (matching dev-woo) and npm. Once per clone/checkout:

```sh
npm install     # dependencies + the Playwright browser download used by npm run e2e
```

## Using it on the whiteboard

1. **Arm it.** Hold **F9**, or tap the mic button in the toolbar (next to the shape tools) to latch it on; tap
   again to turn it off. The button glows while armed and pulses while the mic hears you.
2. **Draw while you speak.** A rough oval or box becomes an area whose text is fitted inside it; a roughly
   horizontal stroke becomes a line with the text sitting along it (underline-style). A near-vertical stroke
   becomes an area. A tap does nothing. See the thresholds below.
3. **Keep going.** Draw the next shape and keep talking — the previous segment is sent off in the background and
   its text appears when it is ready. A small badge on the mic button counts what is still pending.
4. **Speak without drawing** and the text lands as a plain text element where you last touched the board.
5. **Exact shapes:** pick a native tool first (rectangle, ellipse, diamond, line), then arm with F9/the mic
   button. The shape you draw with that tool is used as the container as-is, so you get exact geometry instead of
   a recognised freehand one. Otherwise the tool switches to freedraw for the hold and switches back afterwards.
6. **Placeholder states:** dashed outline + "·/··/···" means the transcript is on its way; **⚠ STT** in red means
   the server did not answer. A retry button appears next to the mic button — tap it to re-send everything that
   failed (the audio is kept in memory). If you said nothing, the shape is kept and the placeholder disappears.
   Delete a shape while it is pending and its transcript is dropped silently.
7. **Settings:** long-press the mic button (~0.6 s), or use the ⚙ button in the top-right. There you set the STT
   server URL, language (auto/ko/en/ja/zh), a prompt hint, which microphone to use, the maximum font sizes for
   areas and for line text, and the minimum segment length; a "test" button records a moment and shows what the
   server heard.

### Which stroke becomes which shape

Recognition is pure geometry on the raw stroke points (`src/stroke.ts`), in screen pixels, in this order:

| Stroke | Test (defaults) | Result |
| --- | --- | --- |
| Tap / tiny flick | bounding-box diagonal < **12 px** | nothing — no shape, no audio |
| Straight-ish, within **60°** of horizontal | every point within **12 %** of the chord length off the straight line start→end, and the chord ≥ **70 %** of the travelled path | **line**, text along it (a 300 px swipe sloping 20° still counts) |
| Straight-ish, steeper than **60°** | same straightness test | **rectangle**, widened to at least **80 px** so words fit (a vertical stroke is useless as a text line) |
| Anything curved or closed, filling ≥ **87 %** of its bounding box | polygon area ÷ bounding-box area | **rectangle** (a boxy scribble) |
| Anything curved or closed, filling < **87 %** | same ratio — a circle fills ~79 % | **ellipse** |

The 70 % chord/path rule is what keeps a back-and-forth scribble from being read as a line. All five numbers are
`RecognizeOptions` overrides in `contracts.ts`, not user settings.

## Deploy

Built on **dev-woo** and copied to the whiteboard (`root@100.102.3.47`) as a static bundle:

```sh
npm run build              # tsc --noEmit + vite build; prebuild copies the library fonts into public/fonts
scripts/deploy.sh          # build + rsync dist/ + restart the kiosk
scripts/deploy.sh --no-build
```

**Access required:** `100.102.3.47` is a **Tailscale-only** address — plain `ssh` from outside the tailnet will
hang or be refused, and there is no public route to the whiteboard. You need the box on the tailnet and key-based
`root@` SSH to it (dev-woo already has this; verify with `ssh root@100.102.3.47 true`). Override the target with
`WB_HOST=user@host scripts/deploy.sh` if it moves.

`deploy.sh` rsyncs `dist/` into `/home/euidos/excalidraw`, which the user unit `excalidraw.service` serves with
`python http.server` on `127.0.0.1:8765`, then restarts the kiosk unit `excalidraw-ui.service`. The kiosk runs
`/usr/local/bin/excalidraw` (`scripts/excalidraw-launcher.sh`): snap Chromium in `--app=http://127.0.0.1:8765`
mode with `--use-fake-ui-for-media-stream` (grants the microphone without a prompt — the page is local-only) and
`--remote-debugging-port=9222` for CDP probes. From dev-woo:

```sh
ssh -f -N -L 9223:127.0.0.1:9222 root@100.102.3.47
node scripts/kiosk-probe.mjs /tmp/kiosk.png [--stroke]   # URL, voice status, mics, STT health, fonts, optional live stroke
```

## Speech-to-text server

The app talks to an OpenAI-compatible endpoint (`POST /v1/audio/transcriptions`, `GET /health`), by default
`http://100.81.33.83:8770`. That is faster-whisper on **desktop-woo**, the founder's own Windows desktop on the
same LAN as the whiteboard — **the founder is the owner and the only contact; there is no on-call and no
redundancy.** It runs as the logon scheduled task "STT server" (files in `C:\Users\jeeni\stt`; the server source
is mirrored at `/root/dev_workspaces/stt-server`), warm ~10 s after start. CORS is open so both the whiteboard
and dev builds can reach it. Nothing is sent anywhere else; there is no cloud path.

If it is down: see the outage runbook in [Troubleshooting](#troubleshooting) below and the host facts in
`.re0/iteration/0.1.0-voice-areas/REF-hosts.local.md` (SSH alias, shell quirks, task commands).

## Test clips

`test/fixtures/` holds real 16 kHz mono WAVs used as Chromium's fake microphone: `jfk.wav` (11 s English),
`en-short`/`en-long`, `ko-short`/`ko-long`/`ko-mixed` (Korean TTS), plus `three-utterances.wav` (three labels
separated by silence). `jfk-dense.wav` and `silence.wav` are generated on first use by the e2e helpers.

## Running the tests locally

```sh
npm install     # once, see Setup
npm test        # vitest: stroke recognition geometry, no browser needed
npm run build   # typecheck + production bundle
npm run e2e     # Playwright: real browser, fake mic fed with the WAVs, REAL STT server
```

`npm run e2e` starts `vite preview` on `127.0.0.1:4173` itself, but it needs the STT server reachable — if it is
down the failure paths pass and the transcript assertions do not. Screenshots for each gate land in
`test-results/evidence/`, the HTML report in `playwright-report/`.

## Troubleshooting

- **Mic not granted / no recording.** The mic button shows a "no mic" state and `status().mic` is `denied` or
  `missing`. On the kiosk that means the launcher lost `--use-fake-ui-for-media-stream`, or snap Chromium's
  `audio-record` interface is disconnected. In a normal browser, allow the microphone for the origin. Pick the
  right input in the settings panel (the whiteboard has both the display's USB audio and a bluetooth source).
- **⚠ STT everywhere.** Work down this list; each step is one of the ways the single STT host fails.
  1. `curl http://100.81.33.83:8770/health` from the whiteboard (and from dev-woo). A first request right after a
     start can time out while the model loads — wait ~10 s and retry before concluding anything.
  2. Service stopped: `ssh stt-desktop` then `schtasks /End /TN "STT server" && schtasks /Run /TN "STT server"`,
     wait ~10 s, hit the retry button in the app.
  3. Host asleep, rebooted to a login screen, or renamed/re-addressed: the task only runs at the founder's logon,
     so an unattended reboot leaves it down until someone logs in. Check the tailnet address still answers
     (`tailscale status | grep desktop-woo`) and put the current URL into the settings panel — the URL is a
     setting, so any reachable OpenAI-compatible transcription endpoint works as a stand-in.
  4. Down for longer: ask the founder — it is their desktop and nobody else can power it on. Meanwhile the app
     degrades honestly (shapes are kept, placeholders show ⚠ STT, audio stays in memory for retry until the page
     is reloaded), and `npm run e2e` transcript assertions are meaningless until it is back.
- **Boxes render but text looks wrong / fonts are Helvetica.** The bundled fonts are missing from the deploy:
  `npm run build` runs `scripts/copy-fonts.mjs`, which copies the library's `dist/prod/fonts` into
  `public/fonts`; they must end up at `/fonts` on the server, with `window.EXCALIDRAW_ASSET_PATH = "/"` (set in
  `index.html`).
- **Old drawings missing.** The app reads the vanilla keys `excalidraw`, `excalidraw-state`, `excalidraw-library`,
  `excalidraw-theme` and the `files-db` IndexedDB store — they are per-origin, so the app must be served from the
  same origin as before (`http://127.0.0.1:8765`). A different port, hostname or browser profile shows an empty
  board; the old data is not lost, it is just on the other origin.
