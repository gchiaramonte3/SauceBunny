import { describe, expect, it } from "vitest";
import { formatTimeAgo } from "./transcript-history";

/**
 * "3m ago" under each transcript in the history popover. Untested, and it
 * carries one guard worth pinning: a timestamp in the FUTURE is clamped to
 * zero rather than counted backwards.
 *
 * That is not hypothetical here. Transcript timestamps come from file mtimes
 * and from other machines in a co-review session, either of which can be ahead
 * of this clock. Without the clamp the popover would read "-4m ago".
 */

const NOW = Date.parse("2026-08-16T12:00:00Z");
const ago = (ms: number) => formatTimeAgo(NOW - ms, NOW);

describe("formatTimeAgo", () => {
  it("reads as just now inside the first minute", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59_000)).toBe("just now");
  });

  it("steps up through minutes, hours, yesterday, days", () => {
    expect(ago(60_000)).toBe("1m ago");
    expect(ago(59 * 60_000)).toBe("59m ago");
    expect(ago(60 * 60_000)).toBe("1h ago");
    expect(ago(23 * 3600_000)).toBe("23h ago");
    expect(ago(24 * 3600_000)).toBe("yesterday");
    expect(ago(2 * 24 * 3600_000)).toBe("2d ago");
    expect(ago(6 * 24 * 3600_000)).toBe("6d ago");
  });

  it("falls back to a date beyond a week", () => {
    // Locale-dependent, so assert the shape rather than the exact string.
    const out = ago(30 * 24 * 3600_000);
    expect(out).not.toMatch(/ago|just now|yesterday/);
    expect(out.length).toBeGreaterThan(3);
  });

  it("never counts backwards from a future timestamp", () => {
    // Clock skew, or a peer's file. "-4m ago" would be the alternative.
    expect(formatTimeAgo(NOW + 4 * 60_000, NOW)).toBe("just now");
    expect(formatTimeAgo(NOW + 5 * 24 * 3600_000, NOW)).toBe("just now");
  });
});
