# excalidraw-voice

A wrapper around `@excalidraw/excalidraw` that adds one tool: **voice area**. Arm it, then draw and talk. A stroke
**selects a region** — it is not a drawing: while the transcript is on its way the region is faint dashed
scaffolding (a bounding box, or the line itself) with an animated placeholder inside it, and when the words land the
scaffolding is deleted, leaving the transcript alone on the canvas at the largest font size that fits the region you
drew. Strokes never wait for transcripts: several can be in flight at once and results land by element id in
whatever order they arrive.

**Repo:** local-only git repo on **dev-woo** at `/root/dev_workspaces/excalidraw-voice`. No remote, nothing to
clone from a forge: get onto dev-woo (`ssh dev-woo`, key-based root over the tailnet) and work there. Private,
unpublished, no licence — treat it as the founder's code.

**The whiteboard** is a wall-mounted touch display in the founder's office driven by a small Ubuntu 24.04 PC
(tailnet `100.102.3.47`) that boots into Chromium kiosk mode showing a locally served Excalidraw. This app
replaces the static bundle it serves. Because it reads and writes the **vanilla** excalidraw-app storage keys on
the same origin (`http://127.0.0.1:8765`), the founder's existing drawings, app state, library and images carry
over untouched — no import step. On a fresh machine, a new browser profile or any other origin there is simply no
such storage and the app opens an empty board with defaults; that is the normal fresh-install path, not an error.

## Setup

Node 22 (matching dev-woo) and npm. Once per clone/checkout:

```sh
npm install     # dependencies + the Playwright browser download used by npm run e2e
```

## Using it on the whiteboard

1. **Arm it.** Hold **F9**, or tap the mic button to latch it on; tap again to turn it off — a tap of any
   length latches. If the microphone is dead the tool refuses to arm and says why in a toast.

   *Reading the icon:* idle is a plain outline. While armed, **the mic capsule fills from the bottom in
   proportion to how loud the room is** and a ring around it grows with the same number, so "is it listening"
   is answerable from across the room. The fill turns **green** while the app has decided the sound is speech
   and is keeping it (the VAD's own verdict) — that green is "your voice is being recognised"; a grey fill that
   never turns green means the room is loud but nothing crossed the speech threshold, which is a **VAD
   threshold** to adjust in settings. A small red dot pulses whenever the stream is open, even in silence.

   *Finding the button:* it sits **inside the library's own toolbar island at the top of the screen**, appended
   **after the last native tool** (the one at the right end of the row: lock, hand, selection, rectangle,
   diamond, ellipse, arrow, line, draw, text, image, eraser, frame, …) and before the divider and the "more
   tools" chevron. It is a line-art **microphone glyph** (capsule head, U-shaped cradle, short stand) with the
   keybinding **F9** in its corner (the capsule doubles as the level meter above), same size and frame as every
   native tool button; `aria-label` is
   **"Voice area"** and `data-testid` is `toolbar-voice`. The circular-arrow **retry** button appears
   immediately to its right — but only once at least one transcription has failed; with nothing failed it is
   hidden, so an unarmed, healthy board shows the mic alone.
2. **Draw while you speak.** A rough oval or box selects a rectangular region and the text is fitted inside it; a
   roughly horizontal stroke selects a line and the text sits along it (underline-style); a near-vertical stroke
   selects a region too. A tap does nothing. **The words start appearing while you are still talking** — a faint
   preview of the sentence so far, refreshed roughly every second and a bit (Interim results, in settings) — and the
   finished transcript lands the moment you lift the pen, because it was already being recognised while you were
   drawing, not after.
3. **Keep going.** Draw the next shape and keep talking — nothing waits. A badge on the mic button counts what is
   still pending.
4. **Speak without drawing** and the words land as plain text where you last touched the board.
5. **Exact regions:** pick a native tool first (rectangle, ellipse, diamond, line), then arm. The shape you draw
   with that tool becomes the region marker as-is, so you get exact geometry instead of a recognised freehand one —
   and, like any marker, it disappears when the words land. Otherwise the tool switches to freedraw for the hold and
   switches back afterwards.
6. **Region states:** a faint dashed marker + "·/··/···" means the transcript is on its way; when it arrives the
   marker is deleted and only the words remain. **⚠ STT** in red means the server did not answer — that one KEEPS
   its dashed marker so the retry button (the circular arrow that appears next to the mic only when something has
   failed) has a visible target; it re-sends everything that failed (the audio is kept in memory until the page
   reloads), and a failure never overwrites words that already landed. If you said nothing, the marker and the
   placeholder both go when you disarm and a toast says **"No speech heard for that shape"** (or "N regions removed
   — nothing was said") — a drop leaves no ⚠ and no retry, so the toast is how you tell it from a region still
   waiting. Regions you draw are never removed mid-take, so you can lay out several boxes before you start talking.
   Delete a shape while it is pending and its transcript is dropped silently. If a reload catches a pending take,
   the next boot sweeps the leftover markers, placeholders and stranded ⚠ warnings away.

### How the words find their region

The microphone runs continuously while armed and the app cuts it at **silence**, not at your strokes: one speech
burst bounded by silence is one *utterance*. An utterance goes to the latest region whose pen-down happened no
later than **1.5 s after the utterance started** (the pre-roll), so saying the label a beat *before* you draw the
box still lands it in that box; if you draw first and then talk, it lands there too. Practical consequences for
the founder: **pause briefly between labels** so the app can tell them apart — run-on speech across two strokes
is one utterance and goes to one region; several sentences spoken over one region all land in it (appended in the
order spoken, the text refitted to the region each time); speech that no region can claim becomes free text where
the pen last was; palm taps, pans and stray contacts never cut audio, because only silence does. Each utterance is sent as its
own clip (speech plus 250 ms of padding), so mixed Korean/English talk is detected per utterance instead of one
language swallowing the other. Bursts shorter than 0.4 s and known near-silence hallucinations ("감사합니다",
"thanks for watching", "Subtitles by amara.org", …) are dropped rather than written. A drop is never silent: the
filtered text is toasted as **Filtered: "…"** for 2.5 s, and the mic button's tooltip carries a running
**dropped N** with the last one, so a filter that ate real speech is visible instead of looking like a quiet room.

### Settings

Open the **top-left menu** (the hamburger, next to Open / Export image / Reset the canvas) and pick
**Voice settings…**; the panel opens under it. The mic button in the toolbar only latches — no gesture on it
opens settings, because on the IR frame a "tap" is routinely 700 ms and long-press used to steal those taps.

| Setting | Default | What it is for |
| --- | --- | --- |
| STT URL | `http://100.81.33.83:8770` | Any OpenAI-compatible transcription endpoint works as a stand-in. |
| Language | auto | Force `ko` or `en` when auto-detection keeps guessing wrong. Those two are the only languages enabled: the STT server's own allow-list (`STT_LANGUAGES`, default `ko,en`) restricts auto-detection to them and answers any other explicit language with 400, which is what stopped Korean coming back as Japanese. A stored `ja`/`zh` from an older build is reset to auto on load. |
| Prompt | empty | Hint words (names, jargon) handed to whisper. |
| Microphone | Default | The whiteboard has several inputs; an exact device that fails falls back to the default. |
| Max font size | 96 | Upper bound for text inside an area. |
| Line max / **line min** font size | 36 / 14 | Text along a line shrinks to fit the line, but never below the line minimum: at that floor it wraps to the line's length and grows upward instead of shrinking past legibility. |
| **Pre-roll (ms)** | 1500 | How long speech may start *before* its stroke and still belong to it. Raise it if you habitually name a box well before drawing it; lower it if labels keep jumping to the next shape. |
| **Interim results every (ms)** | 1200 | While you are still speaking, the sentence so far is transcribed and previewed in the region at 45% opacity, this long after the previous preview came back. **0 turns previews off** (the final transcript is unaffected). Higher = fewer, longer previews; the preview never becomes the transcript, and a reload always sweeps it. |
| **VAD threshold** + **level bar** | 0.012 | The loudness floor that counts as speech, as a slider over a live level meter with the threshold marked on the same scale — both are drawn from the raw RMS the capture emits (`src/level.ts`, full scale 0.06), so what you see is what the VAD compares. Talk normally and watch the bar: the marker belongs below your speech and above the room's idle noise. The effective floor is whichever is higher, this value or 3× the measured room noise. |
| **Warm mic on boot** | on | Acquire the microphone at page load so the first arm records instantly. Turn it off if you do not want the mic light on until you arm (the e2e turns it off to time fixtures). |

### Which stroke selects which region

Recognition is pure geometry on the raw stroke points (`src/stroke.ts`). Gesture thresholds are **screen** pixels:
they are divided by the current zoom at the call site, so the same physical gesture recognises the same at any
zoom.

**The numbers below are a copy, not the source of truth, and they can drift.** The defaults live as JSDoc on
`RecognizeOptions` in `src/contracts.ts` (`minSize`, `lineDeviation`, `rectFill`, `maxLineAngleDeg`,
`verticalLineAreaWidth`) and the chord/path rule is `MIN_CHORD_PATH_RATIO` in `src/stroke.ts`; read those two
files before trusting a number here or recalibrating one — `grep -n 'Default' src/contracts.ts` prints the whole
set. They are `RecognizeOptions` overrides passed at the call site, not user settings: changing a default means
editing the contract, which is a design decision, and `test/unit/stroke.test.ts` is what proves the new value.

| Stroke | Test (defaults) | Region |
| --- | --- | --- |
| Tap / tiny flick | bounding-box diagonal < **12 px** | nothing — no shape |
| Straight-ish, within **60°** of horizontal | every point within **12 %** of the chord length off the line start→end, and the chord ≥ **70 %** of the travelled path | **line**, text along it (a 300 px swipe sloping 20° still counts) |
| Straight-ish, steeper than **60°** | same straightness test | **box**, widened to at least **80 px** so words fit |
| Curved or closed, filling ≥ **87 %** of its bounding box | polygon area ÷ bbox area | **box** (a boxy scribble) |
| Curved or closed, filling < **87 %** | same ratio — a circle fills ~79 % | **box** (the oval's bounding box; the outline itself is never kept) |

The 70 % chord/path rule keeps a back-and-forth scribble from reading as a line.

## Verifying

```sh
npm install     # once, see Setup
npm test        # vitest: stroke geometry, VAD, assignment, capture, controller, persist, stt — no browser
npm run build   # tsc --noEmit + vite build (prebuild copies the library fonts into public/fonts)
npm run e2e     # Playwright: real browser, fake mic fed with the WAVs, REAL STT server, retries: 0
```

`npm run e2e` starts `vite preview` on `127.0.0.1:4173` itself, but it needs the STT server reachable. **The
suite never checks `/health` itself, so its exit code cannot tell you the server was up.** Always
`curl -sf http://100.81.33.83:8770/health` first; only then is a result meaningful:

- **Green with STT up** — the real proof.
- **STT down** — the geometry and failure-path cases (G3, G5a–c, G6, the native-tool case) still pass, but every
  gate that asserts a transcript (G1, G2, G4a–d) fails, so the run exits **non-zero**. That red is honest but
  ambiguous: it looks exactly like a regression in this app. Re-run against a warm server before believing it.
- **A green run is never possible with the server down**, so green does imply STT answered — but a red one tells
  you nothing until you have checked `/health`.

Screenshots land in `test-results/evidence/`, the run log in `test-results/last-run.txt`, the HTML report in
`playwright-report/`. A flake is a failure: the suite runs with no retries on purpose.

Quick check of a running preview without the full suite: `node scripts/smoke.mjs` (toolbar, debug surface, fonts,
mic) writes `/tmp/smoke.png`.

## Deploy

Built on **dev-woo** and copied to the whiteboard (`root@100.102.3.47`) as a static bundle:

```sh
npm run build
scripts/deploy.sh              # build + rsync dist/ + restart the kiosk
scripts/deploy.sh --no-build
```

**Access required:** `100.102.3.47` is a **Tailscale-only** address — plain `ssh` from outside the tailnet hangs
or is refused, and there is no public route. You need the box on the tailnet and key-based `root@` SSH to it
(dev-woo has it; verify with `ssh root@100.102.3.47 true`). Override the target with `WB_HOST=user@host`.

`deploy.sh` rsyncs `dist/` into `/home/euidos/excalidraw`, which the user unit `excalidraw.service` serves with
`python http.server` on `127.0.0.1:8765`, then restarts the kiosk unit `excalidraw-ui.service`. The kiosk runs
`/usr/local/bin/excalidraw` (`scripts/excalidraw-launcher.sh`): snap Chromium in `--app=http://127.0.0.1:8765`
mode with `--use-fake-ui-for-media-stream` (grants the microphone without a prompt — the page is local-only) and
`--remote-debugging-port=9222` for CDP probes.

### If a deploy breaks the kiosk

`deploy.sh` runs under `set -euo pipefail`, so any step that fails stops the script — but the steps are not
atomic and there is **no automatic rollback**: `rsync --delete` overwrites `/home/euidos/excalidraw` in place and
keeps no previous copy. Take one before a risky deploy if you want a one-command way back:

```sh
ssh root@100.102.3.47 'rm -rf /home/euidos/excalidraw.prev && cp -a /home/euidos/excalidraw /home/euidos/excalidraw.prev'
```

**Did it actually land?** The script's own second-to-last line prints the HTTP status of
`http://127.0.0.1:8765/` and the hashed bundle name from the deployed `index.html` (e.g. `200` and
`index-AbC123.js`). A `200` plus a bundle name that matches your fresh `dist/` means the files are served; a
blank or unchanged hash means rsync went somewhere else.

**The wall is black / still shows the old build.** Files and kiosk are two separate units — check them in that
order:

```sh
ssh root@100.102.3.47 'systemctl --user -M euidos@ status excalidraw.service --no-pager'      # the file server
ssh root@100.102.3.47 'systemctl --user -M euidos@ status excalidraw-ui.service --no-pager'   # Chromium kiosk
ssh root@100.102.3.47 'journalctl --user -M euidos@ -u excalidraw-ui.service -n 50 --no-pager'
```

If the file server is down the page cannot load at all (`curl` above returns nothing); start it with
`systemctl --user -M euidos@ start excalidraw.service`. If only the kiosk unit failed to come back, re-run the
script's own last step by hand:

```sh
ssh root@100.102.3.47 'systemctl --user -M euidos@ restart excalidraw-ui.service ||
  systemd-run --user -M euidos@ --unit=excalidraw-ui /usr/local/bin/excalidraw'
```

A restart that leaves the screen unchanged usually means Chromium reopened the **cached** page; bundle names are
content-hashed, so a hard reload over CDP (`scripts/kiosk-probe.mjs`, which prints the loaded URL and
`status()`) tells you which build is really in the browser.

**Going back to the last known-good build.** Nothing on the whiteboard remembers the old code, so the rollback is
a rebuild on dev-woo:

```sh
ssh root@100.102.3.47 'rsync -a --delete /home/euidos/excalidraw.prev/ /home/euidos/excalidraw/'  # if you took the copy
git log --oneline -10                 # pick the last commit that was deployed and worked
git checkout <good-commit> -- src public index.html   # or: git stash && git checkout <good-commit>
npm run build && scripts/deploy.sh --no-build
```

Then restore your working tree (`git checkout main -- .` / `git stash pop`). Whichever way you go back, the
founder's drawings are untouched: the board lives in the browser profile's storage for
`http://127.0.0.1:8765`, not in `dist/`, so deploying, rolling back and restarting the kiosk never move it. The
one thing that does destroy it is `scripts/kiosk-clear.mjs`.

### Probing the live kiosk

Open the CDP tunnel from dev-woo once, then run any probe against it:

```sh
ssh -f -N -L 9223:127.0.0.1:9222 root@100.102.3.47
node scripts/kiosk-probe.mjs /tmp/kiosk.png [--stroke]
```

| Probe | What it answers |
| --- | --- |
| `kiosk-probe.mjs [png] [--stroke]` | Is the wrapper loaded? URL, `status()`, `settings()`, mic device list, STT `/health` **as seen from the whiteboard**, font check, element count, screenshot. `--stroke` draws one F9-held ellipse with the **real room microphone** and waits for the transcript — the whole pipeline end to end. |
| `kiosk-mic-check.mjs` | Records 3 s from **every** audio input and reports blob bytes, decoded duration, sample rate and peak. Use when a mic is present but produces nothing. |
| `kiosk-blob-check.mjs` | Arms and disarms the app's own controller with no stroke (the orphan path) while intercepting the upload: what was actually POSTed (bytes, decoded seconds) and what the server answered. Use when transcripts come back empty or wrong. |
| `kiosk-offset-check.mjs` | Independent of the app: opens the mic, waits 20 s, records 3 s, sends it straight to the STT server. Separates "our capture is wrong" from "this mic/server is wrong", and shows the round-trip latency. |
| `stt-abort-check.mjs` | Not a kiosk probe: fires two requests at the STT server from a real Chromium page and aborts the second while it is queued behind the GPU, then checks that `/health.skipped` went up. Run it after any change to the server's locking, and start `npm run preview` first (the page has to come from a real origin). |

(There is no `kiosk-clear.mjs` any more. It wiped the founder's live board on 2026-09-18 and was deleted; a probe
may only remove elements it created itself, by id.)

## Speech-to-text server

The app talks to an OpenAI-compatible endpoint (`POST /v1/audio/transcriptions`, `GET /health`), by default
`http://100.81.33.83:8770`. That is faster-whisper on **desktop-woo**, the founder's own Windows desktop on the
same LAN as the whiteboard — **the founder is the owner and the only contact; there is no on-call and no
redundancy.** It runs as the logon scheduled task "STT server" (files in `C:\Users\jeeni\stt`; source mirrored at
/root/dev_workspaces/stt-server), warm ~10 s after start. CORS is open so both the whiteboard and dev builds can
reach it. Nothing is sent anywhere else; there is no cloud path.

One take at a time runs on the GPU. Since round 5 that queue is held by an `asyncio` lock in the request handler and
the handler asks `request.is_disconnected()` the moment it acquires it: a request the browser has already abandoned —
which is what an interim slice becomes as soon as a newer one is cut — is answered **499** without costing any GPU
time, counted in `/health.skipped` and logged as `skipped abandoned request after Xs queued`. So the final take of an
utterance never waits behind previews of itself.

## Test clips

`test/fixtures/` holds real 16 kHz mono WAVs used as Chromium's fake microphone: `jfk.wav` (11 s English),
`en-short`/`en-long`, `ko-short`/`ko-long`/`ko-mixed` (Korean TTS), and `three-utterances.wav` — three labels
separated by real silence, with `three-utterances.json` naming the words expected in each shape; that one is what
proves attribution. `jfk-dense.wav` and `silence.wav` are generated on first use by the e2e helpers.

## Troubleshooting

- **The tool will not arm.** That is the mic channel doing its job: the toast and `status().lastError` say
  whether it was denied, missing or errored. On the kiosk that usually means the launcher lost
  `--use-fake-ui-for-media-stream`, or snap Chromium's `audio-record` interface is disconnected; in a normal
  browser, allow the microphone for the origin. Confirm the hardware with `scripts/kiosk-mic-check.mjs`, then
  pick the right input in the settings panel.
- **It arms but hears nothing / every burst is dropped.** Open the settings panel and watch the level bar while
  talking: if the bar barely moves, it is the input device; if it moves but stays under the threshold marker,
  lower the VAD threshold. Bursts under 0.4 s are dropped by design.
- **Words land in the wrong shape.** Pause longer between labels (one silence = one utterance), and tune
  **pre-roll**: too low and a label spoken before its box goes to the previous shape, too high and it jumps to
  the next one.
- **⚠ STT everywhere.** Each step is one of the ways the single STT host fails.
  1. `curl http://100.81.33.83:8770/health` from the whiteboard and from dev-woo. A first request right after a
     start can time out while the model loads — wait ~10 s and retry before concluding anything.
  2. Service stopped: `ssh stt-desktop`, then `schtasks /End /TN "STT server" && schtasks /Run /TN "STT server"`,
     wait ~10 s, hit retry in the app.
  3. Host asleep, rebooted to a login screen, or re-addressed: the task only runs at the founder's logon, so an
     unattended reboot leaves it down until someone logs in. Check `tailscale status | grep desktop-woo` and put
     the current URL into the settings panel.
  4. Down longer: ask the founder — it is their desktop and nobody else can power it on. Meanwhile the app
     degrades honestly (a failed take KEEPS its dashed region marker and shows ⚠ STT, audio held for retry until
     reload) and the e2e transcript assertions are meaningless.
- **Boxes render but the text is Helvetica.** The bundled fonts are missing from the deploy: `npm run build` runs
  `scripts/copy-fonts.mjs`, which copies the library's `dist/prod/fonts` into `public/fonts`; they must end up at
  `/fonts` on the server, with `window.EXCALIDRAW_ASSET_PATH = "/"` (set in `index.html`).
- **Old drawings missing.** The app reads the vanilla keys `excalidraw`, `excalidraw-state`, `excalidraw-library`,
  `excalidraw-theme` and the `files-db` IndexedDB store — all per-origin, so the app must be served from the same
  origin as before (`http://127.0.0.1:8765`). A different port, hostname or profile shows an empty board; the old
  data is not lost, it is on the other origin.
