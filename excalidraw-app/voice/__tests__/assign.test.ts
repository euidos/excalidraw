import { describe, expect, it } from "vitest";

import assignUtteranceDefault, { assignUtterance } from "../assign";

import type { StrokeRecord, Utterance } from "../contracts-capture";

/** A stroke as the controller records it: the text id of the shape it produced, stamped on the capture clock. */
function stroke(id: string, downMs: number, upMs = downMs + 400): StrokeRecord {
  return { id, downMs, upMs };
}
function utterance(id: number, onsetMs: number, endMs: number): Utterance {
  return { id, onsetMs, endMs };
}

/** The three utterances of the e2e fixture: one speech burst per shape, separated by silence. */
const U1 = utterance(1, 200, 2000);
const U2 = utterance(2, 3600, 6000);
const U3 = utterance(3, 7700, 14000);
/** Long after the last utterance's pre-roll window — everything decided. */
const LATER = 20000;

describe("assignUtterance — the two rhythms the founder actually draws in", () => {
  it("draw then speak: each utterance lands in the shape that was drawn just before it", () => {
    const strokes = [stroke("S1", 0), stroke("S2", 3000), stroke("S3", 7000)];
    expect(assignUtterance(U1, strokes, LATER)).toEqual({
      strokeId: "S1",
      final: true,
    });
    expect(assignUtterance(U2, strokes, LATER)).toEqual({
      strokeId: "S2",
      final: true,
    });
    expect(assignUtterance(U3, strokes, LATER)).toEqual({
      strokeId: "S3",
      final: true,
    });
  });

  it("speak then draw: the label spoken up to a pre-roll before the stroke still lands in it", () => {
    // Every stroke here starts AFTER its utterance's onset, within the 1.5 s pre-roll.
    const strokes = [
      stroke("S1", 1200),
      stroke("S2", 4800),
      stroke("S3", 8800),
    ];
    expect(assignUtterance(U1, strokes, LATER)).toEqual({
      strokeId: "S1",
      final: true,
    });
    expect(assignUtterance(U2, strokes, LATER)).toEqual({
      strokeId: "S2",
      final: true,
    });
    expect(assignUtterance(U3, strokes, LATER)).toEqual({
      strokeId: "S3",
      final: true,
    });
  });
});

describe("assignUtterance — when nobody can claim the speech", () => {
  it("speech starting 2 s before the only stroke is an orphan, but not until the pre-roll has elapsed", () => {
    const strokes = [stroke("S1", 2500)];
    const u = utterance(1, 0, 900);
    // At 1 s the user could still start a stroke that claims this utterance, so the answer is not actionable yet.
    expect(assignUtterance(u, strokes, 1000)).toEqual({
      strokeId: null,
      final: false,
    });
    // At the pre-roll boundary the window is closed: S1's pointer-down at 2500 is too late, forever.
    expect(assignUtterance(u, strokes, 1500)).toEqual({
      strokeId: null,
      final: true,
    });
    expect(assignUtterance(u, strokes, LATER)).toEqual({
      strokeId: null,
      final: true,
    });
  });

  it("a long utterance whose stroke arrives 2.9 s later is an orphan, decided at onset + pre-roll", () => {
    const strokes = [stroke("S1", 3000)];
    const u = utterance(1, 100, 9000); // still being spoken when S1 is drawn
    expect(assignUtterance(u, strokes, 1599)).toEqual({
      strokeId: null,
      final: false,
    });
    expect(assignUtterance(u, strokes, 1600)).toEqual({
      strokeId: null,
      final: true,
    });
  });

  it("with no strokes at all there is nothing to claim it", () => {
    expect(assignUtterance(U1, [], LATER)).toEqual({
      strokeId: null,
      final: true,
    });
  });

  it("a palm tap cannot capture speech: it never became a stroke, so it is not in the list", () => {
    // The controller only records contacts the recogniser turned into a shape; a palm tap between S1 and S2 is
    // absent here, which is exactly why the utterance after it still belongs to S1.
    const strokes = [stroke("S1", 0), stroke("S2", 9000)];
    expect(assignUtterance(utterance(1, 2000, 4000), strokes, LATER)).toEqual({
      strokeId: "S1",
      final: true,
    });
  });
});

describe("assignUtterance — the documented consequence of 'latest candidate wins'", () => {
  it("speech that begins within the pre-roll BEFORE the next stroke belongs to the NEXT stroke", () => {
    // S2's pointer-down (3000) is within the pre-roll of this onset (2000 + 1500 = 3500), so S2 is a candidate
    // alongside S1, and the latest candidate wins. That is the founder saying the label and then drawing the box
    // around it: 'say then draw'. The cost is deliberate — an utterance still running when the next stroke starts
    // is read as belonging to that next stroke, not as a late comment on the previous one.
    const strokes = [stroke("S1", 0), stroke("S2", 3000)];
    expect(assignUtterance(utterance(1, 2000, 5000), strokes, LATER)).toEqual({
      strokeId: "S2",
      final: true,
    });
    // Just outside the window, the same gesture stays with S1.
    expect(assignUtterance(utterance(2, 1499, 5000), strokes, LATER)).toEqual({
      strokeId: "S1",
      final: true,
    });
  });

  it("a stroke exactly at onset + pre-roll is still a candidate (the boundary is inclusive)", () => {
    const strokes = [stroke("S1", 0), stroke("S2", 1500)];
    expect(assignUtterance(utterance(1, 0, 800), strokes, LATER)).toEqual({
      strokeId: "S2",
      final: true,
    });
  });
});

describe("assignUtterance — shape of the function", () => {
  it("does not care about the order strokes are given in", () => {
    const sorted = [stroke("S1", 0), stroke("S2", 3000), stroke("S3", 7000)];
    const shuffled = [sorted[2], sorted[0], sorted[1]];
    for (const u of [U1, U2, U3]) {
      expect(assignUtterance(u, shuffled, LATER)).toEqual(
        assignUtterance(u, sorted, LATER),
      );
    }
  });

  it("breaks a pointer-down tie in favour of the stroke recorded last", () => {
    const strokes = [stroke("A", 1000), stroke("B", 1000)];
    expect(
      assignUtterance(utterance(1, 1000, 2000), strokes, LATER).strokeId,
    ).toBe("B");
  });

  it("honours a custom pre-roll", () => {
    const strokes = [stroke("S1", 0), stroke("S2", 3000)];
    const u = utterance(1, 2000, 5000);
    expect(assignUtterance(u, strokes, LATER, { preRollMs: 0 })).toEqual({
      strokeId: "S1",
      final: true,
    });
    expect(assignUtterance(u, strokes, 2500, { preRollMs: 1000 })).toEqual({
      strokeId: "S2",
      final: false,
    });
  });

  it("is pure: it mutates neither the utterance nor the stroke list", () => {
    const strokes = [stroke("S1", 0), stroke("S2", 3000)];
    const before = JSON.stringify({ u: U2, strokes });
    assignUtterance(U2, strokes, LATER);
    expect(JSON.stringify({ u: U2, strokes })).toBe(before);
  });

  it("is exported both named and default", () => {
    expect(assignUtteranceDefault).toBe(assignUtterance);
  });
});
