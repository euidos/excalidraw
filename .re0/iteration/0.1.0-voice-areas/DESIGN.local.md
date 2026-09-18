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

## Round 4 — four founder requests (quoted verbatim)

1. "When drawing ovals or shapes, it's just for region selection, not actually drawing the shape itself. Once the
   text is written, those shapes need to disappear. Since the goal is simply region selection rather than drawing
   shapes, you should just calculate a bounding box so the font fits inside it. Please update that."
2. "When you press the mic button, it's hard to tell whether the microphone is actively picking up audio. It
   would be great to add an animation to the mic icon itself that reacts to the audio volume, indicating that
   voice input is being recognized."
3. "Placing the settings button in the top right wasn't a bad call, but I think it would be better to put it as
   one of the items in the top-left menu (where options like Open, Save to, and Reset the Canvas are located).
   Please remove the settings button you added to the top right."
4. "Also, please remove Chinese and Japanese from the available languages since we won't be using them. (Make
   sure this is updated on the API side as well if needed.)"

### Decisions taken

- **Request 1 → region markers, not shapes.** A stroke (or a native rectangle/ellipse/diamond/line drawn while
  armed) produces a **region marker**: dashed, `customData.voiceRegion` stamped, transparent fill — never the
  founder's finished shape. Areas are always fitted (and marked) as a rectangle on the stroke's *bounding box*,
  even when `stroke.ts` recognises an ellipse (per the brief: "just calculate a bounding box", not an inscribed
  ellipse). When the transcript lands, `fit.ts` binary-searches the largest font size whose library layout leaves
  a throwaway probe container unchanged, commits the result as a FREE text element (`containerId: null`,
  `autoResize: false`), and deletes the marker in the SAME undoable update as the text — nothing but the words
  remains. Only a *failed* take keeps its marker (dashed) so the retry button has a visible target; `fit.markFailed`
  refuses to overwrite a transcript that already landed (round-4c fix, RETRO L10/L11 below).
- **Request 2 → the glyph itself is the level meter, on its own scale.** `VoiceStatus` gained `speaking` (true
  between VAD onset and offset, false whenever `mode === "idle"` by construction); the mic capsule fills from the
  bottom via an SVG clipPath scaled by `--voice-level`, and a ring around it grows with the same number; both turn
  green while `speaking`. `recording` ("the stream is open") and `speaking` ("the VAD kept this") stay two signals
  because a fill that never turns green is a VAD-threshold problem, not a dead mic. Round-4c narrowed this to two
  named axes in `level.ts` — `meterPercent` (settings bar, full scale 0.06, the VAD slider's own range) and
  `glyphLevel` (mic glyph, full scale 0.25, sqrt-compressed) — after the wall-panel lens measured ordinary speech
  pinning the glyph at 100 % on the settings-panel axis, i.e. a strobe, not an animation.
- **Request 3 → settings move into the top-left main menu; the top-right gear is deleted.** `App.tsx` renders a
  `<MainMenu>` child of `<Excalidraw>` that reproduces the library's own fallback `DefaultMainMenu` composition
  item for item (Open/Export/Reset canvas/etc., same `UIOptions.canvasActions` guards) plus a "Voice settings…"
  row after "Reset the canvas". `renderTopRightUI`, `GEAR_STYLE` and `voice-settings-gear` no longer exist in the
  code (the e2e asserts the testid count is 0). `ToolbarOptions.onOpenSettings` was deleted round-4c once nothing
  called it — no gesture on the toolbar button opens settings any more.
- **Request 4 → ko/en only, enforced on both sides.** The settings panel offers auto/ko/en; `settings.ts`
  coerces any stored value outside `ALLOWED_LANGUAGES` (including a leftover "ja"/"zh") back to auto, because
  `controller.ts` posts `settings.language` straight to the server — a panel-only fix would leave old localStorage
  values 400ing. The STT server (`stt-server/server.py`) gained `STT_LANGUAGES` (default `ko,en`); with no
  explicit language the auto-detector ranks only the allow-listed candidates (fixes Korean occasionally coming
  back transcribed as Japanese, which restricting the *request* alone would not); an explicit disabled language
  answers 400 before the audio is even decoded. Deployed to stt-desktop and proved live (ko/en pass, `language=ja`
  → 400). Residue (RETRO L12/N16): the two allow-lists are independent sources of truth — `/health` does not
  report `STT_LANGUAGES`, so a server-side change can diverge from the client silently.

### Gates added

G9 region lifecycle — a region marker is deleted by its own commit or by the disarm sweep, never by a mid-session
   predicate written for something else (`isSuperseded` only stops assignment); a failed take never overwrites a
   landed transcript; a stamped `customData.voiceFailed` warning is swept by the stamp, never by reading its text.
G10 mic glyph — the glyph tracks `--voice-level` and turns the accent colour only while `speaking`; at least three
   distinct partial levels are observed in one utterance (not a strobe); readable at wall-panel distance (glyph
   SVG forced to 22 px against the library's 16 px default).
G11 settings location — zero `voice-settings-gear` on the board; every vanilla `DefaultMainMenu` testid survives;
   "Voice settings…" opens the same panel from the menu; the panel's own colours resolve to something visible
   outside the `.excalidraw` subtree.
G12 language allow-list — the language `<select>` offers exactly `["", "ko", "en"]`; a stored ja/zh heals to auto
   on load; the STT server answers a disabled language with 400 and ranks auto-detection over the allow-list only.
