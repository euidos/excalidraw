# EVIDENCE — 0.1.0 voice-areas

Gates from DESIGN.local.md; each needs proof from the real surface before it is marked met.
Statuses below are from the round-1 driver run (12/12 e2e green, `npm test` 11/11) read back against the artifacts
on disk. Paths are repo-relative. Round-1 caveats are in RETRO.local.md (L1, L6).

| Gate | Proof required | Status | Proof path / note |
| --- | --- | --- | --- |
| G1 vertical slice | e2e run log + screenshot: transcript inside recognised shape, real WAV, real STT | **met** | `test/e2e/voice.spec.ts:41` (asserts `/fellow americans/i` inside the ellipse, real STT at 100.81.33.83:8770), `test-results/evidence/g1-vertical-slice.png`. Caveat: `jfk.wav` loops for the whole 12.5 s hold, so segment-boundary correctness is not exercised. |
| G2 parallelism | e2e: 3 strokes in one hold, maxPendingSeen ≥ 2, 3 transcripts | **met (weak)** | `test/e2e/voice.spec.ts:76` asserts `maxPendingSeen >= 2` and `completed === 3`; `test-results/evidence/g2-parallelism.png`. Failed attempt 1 (2 bound texts instead of 3) and passed on `retries: 1`; the driver's own report field said `maxPendingSeen: 0`, and the cited `test-results/last-run.txt` does not exist. Re-run at `retries: 0` before trusting this row. |
| G3 recognition | vitest output for stroke.test.ts | **met** | `test/unit/stroke.test.ts` — 11/11 via `npm test` (integrator + driver runs); in-bundle repeat at `test/e2e/voice.spec.ts:112`, `test-results/evidence/g3-recognition.png`. |
| G4 fit | e2e: container dims unchanged after fit for short/long/Korean; line text angle + width | **unmet (partial)** | Line half met: `test/e2e/voice.spec.ts:242,270`, `g4b-line-horizontal.png`, `g4c-line-slanted.png`. Container-invariance half **fails outside the probe's parameters**: `voice.spec.ts:172` proves it only at 240x120; `src/fit.ts:697` adopts the library's grown geometry when minFontSize overflows — a 60x40 ellipse + one Korean sentence measures 60x280 (stylus lens). The gate says "container size unchanged"; it is unchanged only for boxes ≳120x90. |
| G5 failure paths | e2e: dead STT URL → ⚠ placeholder; retry; silent WAV → shape kept; delete-while-pending | **met (scope gap)** | `test/e2e/voice.spec.ts:292,328,362`; `g5a-failure.png`, `g5a-failure-retry.png`, `g5b-silence.png`, `g5c-delete-pending.png`. Untested failure path in the same family: **mic denied / missing / unplugged mid-hold** — `src/audio.ts` swallows it into a private field, so `src/controller.ts:390`'s disarm branch never runs and the tool stays armed recording nothing. No case covers it. |
| G6 continuity | e2e: seeded vanilla localStorage keys load; reload keeps scene | **met** | `test/e2e/voice.spec.ts:396`, `test-results/evidence/g6-continuity.png`. Note: a pending placeholder is persisted verbatim and restored as a permanent ghost (`src/persist.ts:47`, robustness lens) — not covered by this gate. |
| G7 kiosk | round 1 deployed 2026-09-17 22:37 KST: kiosk loads the wrapper (toolbar shows the F9 mic button, /tmp/kiosk-1.png), mic auto-granted (`--use-fake-ui-for-media-stream`), inputs Default/TouchDevice Mono/A6, STT /health ok from the whiteboard, a real-mic stroke via CDP produced ellipse → placeholder → empty transcript → discard (scripts/kiosk-probe.mjs --stroke; server log 22:42:45 `'' `). Each mic records 3 s → 2.94 s decoded (scripts/kiosk-mic-check.mjs). | met (round 1) | main loop |
| G8 docs | CLAUDE.md + README present, cold-read verdict | pending | main loop (`CLAUDE.md`, `README.md` exist, untracked, unread) |

Unregistered round-2 decisions (from REF-hate-round1.local.md) with no gate row yet — see RETRO L5:
`src/contracts-capture.ts` (unimported), `test/fixtures/three-utterances.{wav,json}` (unused),
`ko-long.wav` / `en-long.wav` / `ko-mixed.wav` (unused).
