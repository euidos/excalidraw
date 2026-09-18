/**
 * Display helpers for the boards list. Pure, so they are unit-tested rather
 * than eyeballed in a screenshot.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "3 min ago" — the list's whole job is "which board was touched last", so the
 * scale is coarse on purpose and never invents precision it does not have.
 * Clock skew between the browser and the server can put `updatedAt` slightly in
 * the future; that reads as "just now", not as a negative age.
 */
export const formatRelativeTime = (
  iso: string,
  now: number = Date.now(),
): string => {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "unknown";
  }
  const age = now - then;
  if (age < MINUTE) {
    return "just now";
  }
  if (age < HOUR) {
    const minutes = Math.floor(age / MINUTE);
    return `${minutes} min ago`;
  }
  if (age < DAY) {
    const hours = Math.floor(age / HOUR);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  if (age < 7 * DAY) {
    const days = Math.floor(age / DAY);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  return new Date(then).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

/** Full timestamp for the `title` attribute, where precision IS wanted. */
export const formatAbsoluteTime = (iso: string): string => {
  const then = Date.parse(iso);
  return Number.isFinite(then) ? new Date(then).toLocaleString() : iso;
};

export const formatElementCount = (count: number): string =>
  `${count} ${count === 1 ? "element" : "elements"}`;

/**
 * "by bob@euidos.ai, 3 min ago" — boards show the login as-is (the plan's
 * decision: identity is the email, no display-name mapping), and a row saved
 * before any login existed carries the literal `wall`.
 */
export const formatLastEdited = (
  board: { updatedBy: string; updatedAt: string },
  now?: number,
): string => {
  const when = formatRelativeTime(board.updatedAt, now);
  return board.updatedBy ? `by ${board.updatedBy}, ${when}` : when;
};
