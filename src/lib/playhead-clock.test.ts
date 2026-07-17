import { describe, expect, it } from "vitest";
import { clampSeekFrames, maxSeekSeconds } from "./playhead-clock";

// These pin the RC1 invariant: an unknown duration must never clamp a seek.
// (The historical failure: metadata.duration null/understated → every click
// clamped to frame 0, or dragged back to a false end.)
describe("clampSeekFrames", () => {
  it("passes the target through when duration is unknown (0)", () => {
    // 19:02:10 @ 30fps — the reported repro; must NOT become 0.
    const f = (19 * 60 + 2) * 30 + 10;
    expect(clampSeekFrames(f, 0)).toBe(f);
  });

  it("passes through for negative/garbage durations", () => {
    expect(clampSeekFrames(500, -1)).toBe(500);
  });

  it("clamps to duration-1 when the duration is known", () => {
    expect(clampSeekFrames(500, 300)).toBe(299);
    expect(clampSeekFrames(100, 300)).toBe(100);
  });

  it("floors fractional targets and rejects negatives/NaN to 0", () => {
    expect(clampSeekFrames(10.9, 300)).toBe(10);
    expect(clampSeekFrames(-5, 300)).toBe(0);
    expect(clampSeekFrames(Number.NaN, 300)).toBe(0);
    expect(clampSeekFrames(Number.NaN, 0)).toBe(0);
  });
});

describe("maxSeekSeconds", () => {
  it("is Infinity when the duration is unknown", () => {
    expect(maxSeekSeconds(0, 30)).toBe(Infinity);
    expect(maxSeekSeconds(-3, 30)).toBe(Infinity);
  });

  it("is (duration-1)/fps when known", () => {
    expect(maxSeekSeconds(301, 30)).toBeCloseTo(10);
  });

  it("guards a zero/garbage fps", () => {
    expect(maxSeekSeconds(301, 0)).toBe(300);
  });
});
