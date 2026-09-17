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
