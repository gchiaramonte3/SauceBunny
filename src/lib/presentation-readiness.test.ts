import { describe, expect, it } from "vitest";
import { contiguousBufferAhead, presentationCanPlay } from "./presentation-readiness";
import type { PlaybackReadiness } from "../components/player-handle";

const ready: PlaybackReadiness = { generation: 1, confirmedSeconds: 10, bufferedAheadSeconds: 2,
  durationSeconds: 149, seeking: false, failed: false, hasFutureData: true };
const ranges = (values: number[][]): TimeRanges => ({ length: values.length,
  start: (i) => values[i][0], end: (i) => values[i][1] });
describe("presentation readiness", () => {
  it("uses only the contiguous range containing the playhead", () => {
    expect(contiguousBufferAhead(ranges([]), 10)).toBe(0);
    expect(contiguousBufferAhead(ranges([[0, 11], [15, 40]]), 10)).toBe(1);
    expect(contiguousBufferAhead(ranges([[0, 11], [15, 40]]), 12)).toBe(0);
    expect(contiguousBufferAhead(ranges([[0, 11], [15, 40]]), 20)).toBe(20);
  });
  it("requires the decoded frame, future data, and two seconds of real buffer", () => {
    expect(presentationCanPlay(ready, 10, 24)).toBe(true);
    for (const patch of [{ confirmedSeconds: null }, { confirmedSeconds: 10.1 }, { bufferedAheadSeconds: 1.5 },
      { seeking: true }, { failed: true }, { hasFutureData: false }]) {
      expect(presentationCanPlay({ ...ready, ...patch }, 10, 24)).toBe(false);
    }
    expect(presentationCanPlay(undefined, 10, 24)).toBe(false);
  });
  it("uses fractional frame rate and accepts the short remainder, not end-of-media", () => {
    expect(presentationCanPlay({ ...ready, confirmedSeconds: 10 + 1 / 23.976 }, 10, 23.976)).toBe(false);
    expect(presentationCanPlay({ ...ready, confirmedSeconds: Math.floor(10 * 23.976) / 23.976 }, 10, 23.976)).toBe(true);
    expect(presentationCanPlay({ ...ready, confirmedSeconds: 148.5, bufferedAheadSeconds: 0.5 }, 148.5, 29.97)).toBe(true);
    expect(presentationCanPlay({ ...ready, confirmedSeconds: 149, bufferedAheadSeconds: 0 }, 149, 24)).toBe(false);
  });
});
