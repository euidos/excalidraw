# WORKFLOW — 0.1.0 voice-areas

Round 1 (Workflow tool, dev-woo, cap 6 concurrent agents, 8 CPUs):
1. Main loop: scout hosts, STT server, package internals; write DESIGN/contracts/scaffold (done before launch).
2. BUILD — five module builders in parallel on disjoint files against `src/contracts.ts`
   (stroke, fit, audio+stt, controller, toolbar+persist+settings), frontier-class coder, thorough effort.
3. INTEGRATE — one agent wires App.tsx, runs `npm run build` + `npm test`, fixes type/build errors anywhere.
4. DRIVE — one agent writes and runs the Playwright e2e (fake mic + real STT) covering G1, G2, G4, G5, G6;
   up to 3 fix→rerun laps by a fixer agent.
5. REVIEW — prism-style lenses (correctness, stylus-latency UX, failure robustness, simplicity) each return one
   load-bearing verdict; disagreements resolved by the main loop; agreed fixes applied and e2e rerun.
6. RE0-MEMO — one agent writes RETRO.local.md from the evidence (lessons, anti-patterns, next gates).
7. Main loop: deploy to the whiteboard (backup vanilla, rsync, launcher flags, restart kiosk), probe via CDP,
   update EVIDENCE.local.md, commit.
Round 2+ (nba decides): hate on the shipped slice → fix the root objection → drive again → memo → commit.

Round 4 (four founder requests, workflow tool, opus-class agents for build/review/fix, sonnet-class for the
cheap confirm/memo steps): 1. BUILD — two opus builders in parallel on disjoint files against the same
`src/contracts.ts`: builder A took request 1 (region markers, delete-on-commit, bounding-box fit), builder B took
requests 2–4 (mic-glyph level animation, main-menu settings, ko/en language allow-list incl. the STT server side);
each re-ran `npm test`/`npm run build`/`npm run e2e` and reported green before handoff. 2. REVIEW — two opus
lenses drove the shipped bundle by hand: a hate-stance lens on "correctness of the region lifecycle" (one
load-bearing objection first, no softening) and a persona lens ("wall-panel founder": 65", 1–3 m, stylus only, no
keyboard) that rendered the real settings panel and mic glyph at 4× DPI instead of reading assertions — together
15 findings, most/should/nice. 3. FIX — one opus fixer triaged and applied 12 of 15 (3 explicitly skipped with a
written reason each, not silently dropped), re-drove to unit 150/150 (12 files) and e2e 24/24, and committed
CLAUDE.md/README.md/the two casebook files in the same commit as the code fix. 4. COLD RUN — one sonnet agent,
told not to modify any file, re-ran build/unit/e2e from a fresh shell and reconfirmed every number and evidence
path without trusting the fixer's own report. 5. MEMO (this step) — one sonnet agent turns the four reports above
into DESIGN/EVIDENCE/RETRO/WORKFLOW rows and checks README/CLAUDE.md for anything the fixer's docs pass missed.
Model choice reasoning: build and adversarial review need the strongest available reasoning (destructive-path
defects and rendering-outside-CSS-scope defects are exactly the kind a weaker model reads past); confirming
already-reported numbers and writing them into the casebook does not.
