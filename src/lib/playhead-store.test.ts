import { beforeEach, describe, expect, it } from "vitest";
import {
  getPlayheadFrames,
  getPlayheadSeconds,
  playheadFramesToSeconds,
  setPlayheadFrames,
  subscribePlayhead,
} from "./playhead-store";

// Module-level singleton — start every test from frame 0.
beforeEach(() => setPlayheadFrames(0));

describe("playhead-store", () => {
  it("get returns what set stored", () => {
    setPlayheadFrames(1234);
    expect(getPlayheadFrames()).toBe(1234);
  });

  it("notifies subscribers on change", () => {
    let ticks = 0;
    const off = subscribePlayhead(() => { ticks += 1; });
    setPlayheadFrames(1);
    setPlayheadFrames(2);
    expect(ticks).toBe(2);
    off();
  });

  it("does NOT notify when the frame is unchanged (paused ticks are free)", () => {
    setPlayheadFrames(42);
    let ticks = 0;
    const off = subscribePlayhead(() => { ticks += 1; });
    setPlayheadFrames(42);
    setPlayheadFrames(42);
    expect(ticks).toBe(0);
    off();
  });

  it("listener reads the NEW value during notify", () => {
    let seen = -1;
    const off = subscribePlayhead(() => { seen = getPlayheadFrames(); });
    setPlayheadFrames(77);
    expect(seen).toBe(77);
    off();
  });

  it("unsubscribe stops notifications", () => {
    let ticks = 0;
    const off = subscribePlayhead(() => { ticks += 1; });
    setPlayheadFrames(1);
    off();
    setPlayheadFrames(2);
    expect(ticks).toBe(1);
  });

  it("a listener unsubscribing itself mid-notify doesn't skip peers", () => {
    const seen: string[] = [];
    const offA = subscribePlayhead(() => { seen.push("a"); offA(); });
    const offB = subscribePlayhead(() => { seen.push("b"); });
    setPlayheadFrames(5);
    setPlayheadFrames(6);
    expect(seen).toEqual(["a", "b", "b"]);
    offB();
  });

  it("subscribe returns independent unsubscribers for duplicate listeners", () => {
    let ticks = 0;
    const fn = () => { ticks += 1; };
    const off1 = subscribePlayhead(fn);
    const off2 = subscribePlayhead(fn); // Set dedupes — still one notification
    setPlayheadFrames(9);
    expect(ticks).toBe(1);
    off1();
    off2();
    setPlayheadFrames(10);
    expect(ticks).toBe(1);
  });
});

describe("playheadFramesToSeconds", () => {
  it("divides by the rounded fps", () => {
    expect(playheadFramesToSeconds(60, 30)).toBe(2);
    expect(playheadFramesToSeconds(90, 29.97)).toBe(3); // rounds to 30
  });

  it("clamps a degenerate fps to 1 instead of dividing by zero", () => {
    expect(playheadFramesToSeconds(5, 0)).toBe(5);
    expect(playheadFramesToSeconds(5, -10)).toBe(5);
  });

  it("matches the quantization App applies on the way in", () => {
    // onPlayerTimeUpdate stores Math.floor(seconds × r); deriving seconds back
    // out lands on the frame boundary at or before the raw player time.
    const r = 30;
    const raw = 12.3456;
    const frames = Math.floor(raw * r);
    const derived = playheadFramesToSeconds(frames, r);
    expect(derived).toBeLessThanOrEqual(raw);
    expect(raw - derived).toBeLessThan(1 / r);
  });

  describe("getPlayheadSeconds (the action-time read)", () => {
    it("agrees with the hook's snapshot formula", () => {
      // If these ever diverge, a mark taken from a handler lands on a
      // different frame than the one the composer was showing when it was
      // clicked. Same function underneath; this pins that.
      for (const fps of [23.976, 24, 25, 29.97, 30, 59.94, 60]) {
        for (const f of [0, 1, 47, 1234, 99999]) {
          setPlayheadFrames(f);
          expect(getPlayheadSeconds(fps)).toBe(playheadFramesToSeconds(f, fps));
        }
      }
    });

    it("returns null when inactive, so a mark cannot be stamped at 0:00", () => {
      // The whole reason the seconds shape is nullable. A hidden tab or a
      // source-less panel must refuse the mark, not quietly claim frame 0.
      setPlayheadFrames(500);
      expect(getPlayheadSeconds(30, false)).toBeNull();
      expect(getPlayheadSeconds(30, true)).toBeCloseTo(500 / 30, 10);
    });

    it("reads the CURRENT value, not one captured at subscribe time", () => {
      // The point of an action-time reader: a handler created on an early
      // render must still see where the playhead is when the user clicks.
      const handler = () => getPlayheadSeconds(30);
      setPlayheadFrames(30);
      expect(handler()).toBe(1);
      setPlayheadFrames(90);
      expect(handler()).toBe(3);
    });

    it("does not subscribe, so calling it cannot trigger a render", () => {
      let ticks = 0;
      const off = subscribePlayhead(() => { ticks += 1; });
      for (let i = 0; i < 100; i += 1) getPlayheadSeconds(30);
      expect(ticks).toBe(0);
      off();
    });
  });
});
