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
