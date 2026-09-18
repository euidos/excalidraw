# REF — hate pass on DESIGN (round 1, before any e2e evidence)

Root objection: cutting segments at stroke pointer-down assigns any speech spoken *before* a stroke to the previous
shape (or drops it for the first), so a "say then draw" rhythm shifts every label by one — and the round-1 e2e cannot
see it, because the fake mic loops a single WAV (every window contains speech) and the gates assert presence, not
content. Secondary: no real IR-frame stroke ever reaches recognizeStroke in validation; short near-silent segments make
whisper hallucinate boilerplate ("감사합니다", "Thank you."); on a keyboard-less wall panel the latch button is the only
real path, so the last segment's end boundary is "whenever the founder walks back to the toolbar".

First nail: (a) measure the founder's real onset-vs-pointer-down delta over ~8 labels on the wall (median < −300 ms or
≥ 2/8 utterances starting before their stroke ⇒ pointer-down cutting is wrong for the majority case); (b) rebuild the
e2e fixture as [utterance A][1.5 s silence][B][1.5 s silence][C] played once (%noloop) and assert per-shape WORDS.

Decision (round 2): keep round 1 as the vertical-slice proof, then replace segmenting with a PCM ring buffer + energy
VAD in the browser: utterances are atomic; an utterance is assigned to the latest stroke whose pointer-down is ≤ its
onset + preRoll (1.5 s), finalised once the utterance ends and no later stroke can still claim it; several utterances
may land in one shape (text appended in onset order, refitted each time); WAV segments carry only speech (+200 ms
padding); transcripts from utterances < 400 ms or matching the hallucination blocklist are dropped. (a) becomes a
2-minute morning test for the founder, not a blocker; (b) is built into the round-2 e2e.
