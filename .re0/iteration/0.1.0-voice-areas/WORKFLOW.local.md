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

Round 5 (one founder request, opus-class builder, opus-class hate-stance lens, opus-class fixer, sonnet-class cold
run and memo): 1. BUILD — one opus builder read `controller.ts` whole against the LIVE build (`17a3a1d`) before
writing anything, diagnosed the request as "transcription is coupled to the pen" and split it into a decoupled
WHAT/WHERE design (`settle()` as the single meeting point) plus a chained-cadence interim preview, touching both
this repo and the STT server; measured the before/after number in a throwaway worktree of the OLD commit rather
than deriving it, and reported `165/165` unit, `27/27` e2e. 2. REVIEW — one opus hate-stance lens drove
`controller.ts`'s settle/interim/assignment orderings by hand (not by reading the diff) and, per its own convention,
did not stop at re-reading the code for the must-level finding: it wrote FIVE throwaway test files against the
shipped tree, ran each, deleted them, and reported the log line each one produced — the must-level defect (a failed
take after a landed preview reports nowhere) would not have survived a lens that only argued from source. 3. FIX —
one opus fixer applied every must/should, and for one of them (G5c survives pruning) went further than the lens's
own proposed fix after proving the lens's version does not clear its own repro; three nice-level items were applied
and one was explicitly skipped with a written reason (not silently dropped), each new gate verified to fail against
the pre-fix code by reverting just that one change. 4. COLD RUN — one sonnet agent, told to modify nothing, re-ran
build/unit/e2e from a fresh shell, caught that the task brief's stated HEAD (`17a3a1d`) was one round stale against
the actual repo (`152e7c3`), and re-measured every number itself rather than trusting the fixer's report — the
same discipline as round 4's cold run, now also catching a stale-brief case the brief-writer could not see coming.
5. MEMO (this step) — one sonnet agent found the fixer's own docs pass had already carried DESIGN/EVIDENCE/CLAUDE.md
current through round 5b, and that what the round had NOT yet written down was the review's own open issues as
named, owned gates (RETRO N20–N22) and this paragraph. Lesson for the memo step itself: a fixer's "docs updated in
the same commit" convention can outrun the memo agent that a workflow still schedules after it — check the
casebook's current state before assuming a stage's output is still unwritten.
