import { describe, expect, it } from "vitest";
import { HALLUCINATION_BLOCKLIST, isHallucination } from "../../src/contracts-capture";

describe("isHallucination — what whisper invents out of near-silence", () => {
  it.each([
    ["감사합니다."],
    ["Thank you."],
    [" you "],
    [""],
    ["   "],
    ["시청해주셔서 감사합니다"],
    ["Bye."],
  ])("drops %j", (text) => {
    expect(isHallucination(text)).toBe(true);
  });

  it.each([
    ["회의 안건 정리"],
    ["Ship the voice tool tonight"],
    ["thank you for your input on the plan"], // real speech that merely starts with a blocklisted phrase
  ])("keeps %j", (text) => {
    expect(isHallucination(text)).toBe(false);
  });

  // Round 2 pinned these as a KNOWN GAP: both halves were listed ("subtitles by", "amara.org") but the phrase
  // whisper actually emits joins them, and the fuzzy arm only tolerates 3 extra characters. Round 3 lists the
  // joined phrases themselves, so the gap is closed by the blocklist rather than by loosening the match.
  it.each([
    ["Subtitles by amara.org"],
    ["subtitles by amara.org."],
    ["Subtitles by the Amara.org community"],
    ["시청해 주셔서 감사합니다"],
    ["자막 by"],
  ])("drops the near-silence filler %j", (text) => {
    expect(isHallucination(text)).toBe(true);
  });

  it("matches a whole normalised text that differs from an entry only in spacing", () => {
    // Whisper is inconsistent about Korean spacing, and spacing is not a word boundary there.
    expect(isHallucination("시청해주셔서 감사합니다")).toBe(true);
    expect(isHallucination("시청해 주 셔서 감사 합니다")).toBe(true);
    expect(isHallucination("thankyou")).toBe(true);
    // …but it is equality, not a substring: a real sentence that merely contains one is kept.
    expect(isHallucination("자막 by 한효정이 만든 회의록")).toBe(false);
  });

  it("only forgives a blocklisted phrase up to three extra characters of noise", () => {
    expect(isHallucination("um thank you")).toBe(true); // 12 chars ≤ "thank you" + 3
    expect(isHallucination("well, thank you")).toBe(false);
  });

  // The fuzzy arm used to apply to every entry, so the 3-character entries ate ordinary words: a shape labelled
  // "young" or "뉴스룸" came back blank with no ⚠, no retry and nothing in the status.
  it.each([["young"], ["youth"], ["your"], ["yours"], ["payout"], ["goodbye"], ["뉴스룸"], ["속보 뉴스"], ["뉴스 데스크"]])(
    "keeps the short real label %j that a short blocklist entry is a substring of",
    (text) => {
      expect(isHallucination(text)).toBe(false);
    },
  );

  it("still drops the short entries themselves, exactly", () => {
    for (const text of ["you", "You.", "bye", "뉴스", " 뉴스 "]) expect(isHallucination(text)).toBe(true);
  });

  it("every blocklist entry is itself caught", () => {
    for (const entry of HALLUCINATION_BLOCKLIST) expect(isHallucination(entry)).toBe(true);
  });
});
