import { describe, expect, it } from "vitest";
import { markRangeFromSeconds } from "./mark-range";

describe("markRangeFromSeconds", () => {
  it("converts a cue span to frames", () => {
    expect(markRangeFromSeconds(10, 20, 25, 10_000)).toEqual({ inFrames: 250, outFrames: 500 });
  });

  it("rounds rather than truncating, so a cue boundary lands on its own frame", () => {
    // 10.02s at 25fps is frame 250.5. Truncating drops half a frame on every
    // mark made from a transcript, always early.
    expect(markRangeFromSeconds(10.02, 20, 25, 10_000)?.inFrames).toBe(251);
  });

  it("clamps to the last frame of the source", () => {
    const r = markRangeFromSeconds(1, 9_999, 25, 100);
    expect(r).toEqual({ inFrames: 25, outFrames: 99 });
  });

  it("does NOT clamp to zero while the duration is unknown", () => {
    // 0 means "still loading", not "zero length". Clamping there would mark
    // frame 0 to frame 0 on every selection made before the source settled.
    expect(markRangeFromSeconds(10, 20, 25, 0)).toEqual({ inFrames: 250, outFrames: 500 });
  });

  it("refuses a zero-length or inverted range", () => {
    // The export refuses these much later and much less clearly, so the marks
    // are left as they were instead.
    expect(markRangeFromSeconds(10, 10, 25, 10_000)).toBeNull();
    expect(markRangeFromSeconds(20, 10, 25, 10_000)).toBeNull();
  });

  it("refuses a range that rounds to the same frame", () => {
    // Two cues 10ms apart at 25fps are one frame. A clip cannot be zero long.
    expect(markRangeFromSeconds(10.0, 10.01, 25, 10_000)).toBeNull();
  });

  it("refuses a range entirely past the end, rather than marking the last frame twice", () => {
    expect(markRangeFromSeconds(500, 600, 25, 100)).toBeNull();
  });

  it("survives a missing or nonsense fps", () => {
    // fps is 0 until the source is probed, and NaN if a probe failed.
    expect(markRangeFromSeconds(10, 20, 0, 10_000)).toBeNull();
    expect(markRangeFromSeconds(10, 20, NaN, 10_000)).toBeNull();
    expect(markRangeFromSeconds(NaN, 20, 25, 10_000)).toBeNull();
  });
});
