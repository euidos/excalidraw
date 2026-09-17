# EVIDENCE — 0.1.0 voice-areas

Gates from DESIGN.local.md; each needs proof from the real surface before it is marked met.

| Gate | Proof required | Status |
| --- | --- | --- |
| G1 vertical slice | e2e run log + screenshot: transcript inside recognised shape, real WAV, real STT | pending |
| G2 parallelism | e2e: 3 strokes in one hold, maxPendingSeen ≥ 2, 3 transcripts | pending |
| G3 recognition | vitest output for stroke.test.ts | pending |
| G4 fit | e2e: container dims unchanged after fit for short/long/Korean; line text angle + width | pending |
| G5 failure paths | e2e: dead STT URL → ⚠ placeholder; retry; silent WAV → shape kept; delete-while-pending | pending |
| G6 continuity | e2e: seeded vanilla localStorage keys load; reload keeps scene | pending |
| G7 kiosk | CDP screenshot from the whiteboard kiosk + STT round trip from the whiteboard | pending |
| G8 docs | CLAUDE.md + README present, cold-read verdict | pending |
