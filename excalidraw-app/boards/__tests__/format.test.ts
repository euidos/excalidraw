import { describe, expect, it } from "vitest";

import {
  formatElementCount,
  formatLastEdited,
  formatRelativeTime,
} from "../format";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatRelativeTime", () => {
  it("collapses anything under a minute to 'just now'", () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("just now");
    expect(formatRelativeTime(ago(59_000), NOW)).toBe("just now");
  });

  it("counts whole minutes, then whole hours, then whole days", () => {
    expect(formatRelativeTime(ago(60_000), NOW)).toBe("1 min ago");
    expect(formatRelativeTime(ago(3 * 60_000), NOW)).toBe("3 min ago");
    expect(formatRelativeTime(ago(59 * 60_000), NOW)).toBe("59 min ago");
    expect(formatRelativeTime(ago(60 * 60_000), NOW)).toBe("1 hour ago");
    expect(formatRelativeTime(ago(5 * 3_600_000), NOW)).toBe("5 hours ago");
    expect(formatRelativeTime(ago(25 * 3_600_000), NOW)).toBe("1 day ago");
    expect(formatRelativeTime(ago(3 * 86_400_000), NOW)).toBe("3 days ago");
  });

  it("falls back to a date past a week, rather than 'just now' arithmetic nobody reads", () => {
    const old = formatRelativeTime(ago(30 * 86_400_000), NOW);
    expect(old).not.toMatch(/ago/);
    expect(old).toMatch(/2026/);
  });

  it("a server clock slightly ahead of the browser reads 'just now', never a negative age", () => {
    expect(formatRelativeTime(new Date(NOW + 5_000).toISOString(), NOW)).toBe(
      "just now",
    );
  });

  it("an unparseable timestamp is 'unknown', not NaN", () => {
    expect(formatRelativeTime("not a date", NOW)).toBe("unknown");
  });
});

describe("formatElementCount", () => {
  it("singularises", () => {
    expect(formatElementCount(0)).toBe("0 elements");
    expect(formatElementCount(1)).toBe("1 element");
    expect(formatElementCount(42)).toBe("42 elements");
  });
});

describe("formatLastEdited", () => {
  it("names the editor's login as stored — the plan's identity is the email", () => {
    expect(
      formatLastEdited(
        { updatedBy: "bob@euidos.ai", updatedAt: ago(3 * 60_000) },
        NOW,
      ),
    ).toBe("by bob@euidos.ai, 3 min ago");
  });

  it("drops the 'by' clause when nothing wrote the row", () => {
    expect(
      formatLastEdited({ updatedBy: "", updatedAt: ago(3 * 60_000) }, NOW),
    ).toBe("3 min ago");
  });
});
