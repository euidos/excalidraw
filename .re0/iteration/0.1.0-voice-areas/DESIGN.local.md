# DESIGN — 0.1.0 voice-areas (full cycle)

Understood as: the founder's stylus writing on the whiteboard is the bottleneck, so a new "voice" tool lets a stroke
designate WHERE text goes (its box and size) while speech supplies WHAT the text is; recognition runs in the
background per segment so the next stroke never waits for the previous transcript. Weight: **full** — the interaction
model (tool vs. modifier, how segments are cut, what a line means) is genuinely contestable.

## Thesis

Excalidraw on the whiteboard becomes a wrapper app (`@excalidraw/excalidraw` 0.18.1 + our modules) that adds one
tool: **voice area**. While the tool is armed (F9 held, or latched by its toolbar button) the microphone records;
each stylus stroke is recognised as a line / ellipse / rectangle and immediately replaced by a proper Excalidraw
shape holding an animated placeholder; the audio segment belonging to that shape is sent to the founder's local
speech-to-text server the moment the next stroke begins (or the hold ends), and the transcript is fitted into the
shape when it arrives. N segments may be in flight at once; results land by element id, in any order.

## Scope

In:
- Wrapper app, same origin/paths as the vanilla deploy (`http://127.0.0.1:8765`, fonts at `/fonts`), reading the
  vanilla app's localStorage keys so existing drawings, app state and library carry over.
- Toolbar button injected next to the native shape tools, shortcut label F9, states: armed / recording / pending
  count / mic missing.
- Stroke recognition (line vs. area; area = rectangle when the stroke's polygon fills ≥ 0.87 of its bbox, else
  ellipse). Near-vertical lines become an area. Taps (< 12 scene px) are ignored.
- Modifier behaviour: if a native shape tool (rectangle / ellipse / diamond / line) is active when armed, that
  tool's element is used as-is as the container; otherwise the tool switches to freedraw for the hold and restores
  the previous tool afterwards.
- Segment cutting: the audio segment for shape N runs from max(arm time, stroke N pointer-down) to stroke N+1
  pointer-down or disarm. A hold with speech but no stroke lands the text as a plain text element at the last
  pointer position.
- Text fitting: largest font size (≤ max) at which the library's own bound-text wrapping does not grow the
  container; lines get a text element rotated along the line, centred, sitting on its upper side, font size ≤ line max.
- Placeholder: container stroke goes dashed + bound text animates "·/··/···" until the transcript lands; failure
  shows "⚠ STT" in red, keeps the audio for retry; empty transcript restores the shape and removes the placeholder.
- STT client against `POST /v1/audio/transcriptions` (OpenAI-compatible), CORS enabled server-side (done).
- Settings (localStorage): STT URL, language (auto/ko/en), prompt, mic device, max font sizes.
- Real-surface proof: Playwright on dev-woo with Chromium's fake mic fed by real speech WAVs against the real STT
  server; then deploy to the whiteboard and probe the kiosk.

Out (this cycle): silence-based auto cutting, editing transcripts by voice, collaboration, translation, streaming
partial transcripts, a Windows-side change beyond CORS.

## Quality gates

G1 Vertical slice — F9 held + one stroke + speech → text fitted inside the recognised shape; proven in the browser
   with a real WAV through the real STT server (not mocked).
G2 Parallelism — three strokes in one hold produce three placeholders visible at once and three transcripts; no
   stroke waits on a transcript (max pending seen ≥ 2 in the e2e run).
G3 Recognition — unit tests: synthetic circle → ellipse, box → rectangle, straight stroke → line, tap → null,
   near-vertical → area.
G4 Fit — text never overflows its container (container size unchanged after fit) for short, long and Korean
   transcripts; line text is rotated along the line and does not exceed line length.
G5 Failure paths — STT unreachable → "⚠ STT" placeholder, retry works when the server is back; empty transcript →
   shape kept, placeholder removed; deleting the shape while pending drops the result silently.
G6 Continuity — existing whiteboard drawings, app state and library survive the switch to the wrapper (same
   localStorage keys; files from IndexedDB `files-db`); reload keeps the scene.
G7 Kiosk — deployed build loads at `http://127.0.0.1:8765` in the snap Chromium `--app` kiosk with mic auto-granted,
   fonts render (Excalifont), STT reachable from the whiteboard (CORS ok).
G8 Docs reflection — CLAUDE.md carries mechanism/rules/anatomy for agents; README carries the user-facing
   catalogue (how to use the tool, settings, deploy, troubleshoot).

## Contestable decisions (settled for this cycle)

- Tool + modifier, not one or the other: both readings of the brief are cheap once stroke capture is hijacked
  from freedraw, and the modifier path gives exact shapes when wanted.
- Segments cut at stroke pointer-down, not at pointer-up: speech usually starts before or during the stroke and
  continues after it; the next stroke is the only reliable "I'm done with that one" signal.
- Lines are kept (they read as underlines) and get text along their slope; areas are kept as containers.
- Freedraw hijack over a custom overlay: reuses Excalidraw's own touch/pen handling on the IR touch frame.

## Round 2 — what changes and why (after the round-1 e2e, four review lenses and the hate pass)

Round 1 proved the vertical slice on the real STT server (12/12 e2e) and shipped to the kiosk. Every lens failed it
on a boundary, not a module. Round 2 fixes the boundaries; contracts in `src/contracts-capture.ts` become live.

R1 Attribution — replace MediaRecorder segments cut at pointer-down with a PCM ring buffer + energy VAD
   (`capture.ts`) and a pure utterance→stroke assignment (`assign.ts`): an utterance is one speech burst bounded
   by silence; it belongs to the latest stroke whose pointer-down is ≤ its onset + preRoll (1.5 s); several
   utterances may land in one shape (text appended in onset order, refitted); an utterance that no stroke can claim
   is an orphan (free text at the last pointer position). Each utterance is sent as its own WAV (only speech + 250 ms
   padding), so whisper detects the language per utterance — the round-1 fixture proved a mixed Korean/English
   window transcribed as Korean drops the English sentence entirely. Utterances < 400 ms and blocklisted
   hallucinations are dropped. Palm contacts / pans no longer cut anything.
R2 Race-free stroke capture — the element for a stroke is identified at pointer-up from
   `api.getAppState().newElement` (set at pointer-down, still set when onPointerUp fires), with a per-stroke id diff
   as fallback; the deferred conversion carries that id, so a pointer-down or disarm inside the deferred window can
   never skip a stroke, and undo-restored elements are never mistaken for the new stroke.
R3 Visible failure — the capture module reports mic state through a channel (`onMicChange`), the controller
   refuses to arm without a working mic (status.lastError, toast), a track `ended`/`mute` disarms, an exact deviceId
   that fails falls back to the default mic, utterances are bounded (20 s), failed segments are capped (keep the
   last 20), and on boot the persister sweeps ghost placeholders (dashed containers whose bound text is a
   placeholder frame or "⚠ STT") back to plain shapes.
R4 Zoom invariance — recognition thresholds are screen-relative: minSize etc. are divided by `appState.zoom.value`.
R5 Line legibility — text along a line wraps to the line's length at a floor font size (14) and grows upward,
   instead of shrinking to 10 px and spilling past the ends.
R6 Toolbar — tap = latch (any press duration), the gear (top-right) opens settings; the long-press path is removed.
R7 Evidence integrity — Playwright `retries: 0`; the run log is written to the path the report cites; the
   three-utterance fixture (played once) asserts the WORDS in each shape, in both rhythms (draw-then-speak and
   speak-then-draw) and with a palm-like tap between strokes.

Gates added (from RETRO.local.md): N2 boundary-race, N3 visible failure, N5 zoom invariance, N6 utterance
assignment by words, N7 single contract (no unreferenced module in src/), N8 evidence integrity. G4's growth
behaviour stays: a shape too small for even the floor font size is grown by the library (documented, not silent:
the placeholder turns solid and the text is committed; the founder sees the box grow).
