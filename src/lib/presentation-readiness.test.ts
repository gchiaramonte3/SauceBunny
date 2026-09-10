import { describe, expect, it } from "vitest";
import { contiguousBufferAhead, presentationCanPlay, presentationCanSwitch, observeDecodedFrame } from "./presentation-readiness";
import type { PlaybackReadiness } from "../components/player-handle";

const ready: PlaybackReadiness = { generation: 1, confirmedSeconds: 10, bufferedAheadSeconds: 2,
  durationSeconds: 149, seeking: false, failed: false, hasFutureData: true };
const ranges = (values: number[][]): TimeRanges => ({ length: values.length,
  start: (i) => values[i][0], end: (i) => values[i][1] });
describe("presentation readiness", () => {
  it("requires fresh advancing decoded frames and five contiguous seconds for a running switch", () => {
    const advancing = { ...ready, bufferedAheadSeconds: 5, sampledAtMs: 1000, advancingFrames: 2 };
    expect(presentationCanSwitch(advancing, 10, 24, 1001)).toBe(true);
    for (const patch of [{ sampledAtMs: 500 }, { sampledAtMs: undefined }, { advancingFrames: 0 },
      { confirmedSeconds: 10.1 }, { bufferedAheadSeconds: 4.99 }, { hasRequiredTracks: false },
      { seeking: true }, { failed: true }, { hasFutureData: false }]) {
      expect(presentationCanSwitch({ ...advancing, ...patch }, 10, 24, 1001)).toBe(false);
    }
    expect(presentationCanSwitch({ ...advancing, confirmedSeconds: 148, bufferedAheadSeconds: 1 }, 148, 23.976, 1001)).toBe(true);
    expect(presentationCanSwitch({ ...advancing, confirmedSeconds: 149 }, 149, 24, 1001)).toBe(false);
  });
  it("resets advancing evidence after generation changes, duplicate frames or an idle gap", () => {
    const a = observeDecodedFrame(null, 1, 10, 1000);
    const b = observeDecodedFrame(a, 1, 10.04, 1040);
    expect(b.advancingFrames).toBe(1);
    expect(observeDecodedFrame(b, 2, 10.08, 1080).advancingFrames).toBe(0);
    expect(observeDecodedFrame(b, 1, 10.04, 1080).advancingFrames).toBe(0);
    expect(observeDecodedFrame(b, 1, 12, 2000).advancingFrames).toBe(0);
  });
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
