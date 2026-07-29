import { describe, expect, it } from "vitest";
import { formatTimeAgo } from "./transcript-history";

/**
 * The ONE time-ago function. There used to be two — upload-date's
 * formatRelative and this — with the same ladder and two differences, both
 * favouring this one: it has a "yesterday" case, and it takes `now` as a
 * parameter so it can actually be tested. formatRelative called Date.now()
 * internally and could not be.
 *
 * The user-visible half of the duplication: the notification bell and the
 * sidebar's recents rendered the same instant differently — one said
 * "yesterday", the other "1d ago".
 */
const NOW = 1_700_000_000_000;
const ago = (ms: number) => formatTimeAgo(NOW - ms, NOW);
const SEC = 1000, MIN = 60 * SEC, HR = 60 * MIN, DAY = 24 * HR;

describe("formatTimeAgo", () => {
  it("walks the ladder", () => {
    expect(ago(5 * SEC)).toBe("just now");
    expect(ago(5 * MIN)).toBe("5m ago");
    expect(ago(5 * HR)).toBe("5h ago");
    expect(ago(3 * DAY)).toBe("3d ago");
  });

  it("says yesterday, which is the whole reason this one won", () => {
    expect(ago(DAY)).toBe("yesterday");
    expect(ago(DAY + 3 * HR)).toBe("yesterday");
    expect(ago(2 * DAY)).toBe("2d ago");
  });

  it("falls back to a date past a week", () => {
    expect(ago(8 * DAY)).toMatch(/\w+ \d+/);
  });

  it("clamps a future timestamp instead of counting backwards", () => {
    // Clock skew, or a file whose mtime is ahead. "-3m ago" is nonsense.
    expect(formatTimeAgo(NOW + 5 * MIN, NOW)).toBe("just now");
  });

  it("steps exactly at each boundary", () => {
    expect(ago(59 * SEC)).toBe("just now");
    expect(ago(60 * SEC)).toBe("1m ago");
    expect(ago(59 * MIN)).toBe("59m ago");
    expect(ago(60 * MIN)).toBe("1h ago");
    expect(ago(23 * HR)).toBe("23h ago");
    expect(ago(24 * HR)).toBe("yesterday");
  });
});
