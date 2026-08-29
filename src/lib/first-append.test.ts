import { describe, expect, it } from "vitest";
import { planFirstAppend } from "./first-append";

const base = {
  painted: false, absolute: true, pendingLand: null as number | null,
  bufferedStart: 2661, bufferedEnd: 2666.5, currentTime: 0, paused: true, hasBuffer: true,
};

describe("first append of a rebuilt pipeline", () => {
  it("nudges a paused rebuild so WKWebView presents a frame", () => {
    // The bug this exists for: paused, a fresh MediaSource presents nothing.
    const p = planFirstAppend({ ...base, pendingLand: null });
    expect(p.nudgeTo).toBe(2661);
    expect(p.burnOneShot).toBe(true);
  });

  it("REBASED mode: clears a landing target that mode can never consume", () => {
    // Bug 1. The rebuild timer arms pendingLand for BOTH modes, but only
    // absolute mode ever seeks to it. Left armed, it blocked the nudge
    // forever on exactly the path the nudge was written for (HLS, peer
    // streams) - and the one-shot was burned first, so nothing retried.
    const p = planFirstAppend({ ...base, absolute: false, pendingLand: 2666 });
    expect(p.clearLand).toBe(true);
    expect(p.landTo).toBeNull();
    expect(p.nudgeTo).toBe(2661);
  });

  it("ABSOLUTE mode: a landing seek is the paint, and is NOT overwritten", () => {
    // Bug 2, the worse one. The landing seek cleared pendingLand, then the
    // nudge saw null and overwrote currentTime with the buffer origin - a
    // paused click at 2666.0 landed at 2661.0, a whole GOP early.
    const p = planFirstAppend({ ...base, pendingLand: 2666 });
    expect(p.landTo).toBe(2666);
    expect(p.nudgeTo).toBeNull();
    expect(p.clearLand).toBe(true);
    expect(p.burnOneShot).toBe(true);
  });

  it("does not spend the one-shot while a reachable landing target is still buffering", () => {
    // Absolute mode, buffer has not reached the target yet. Burning the
    // one-shot here means no later append can ever paint.
    const p = planFirstAppend({ ...base, pendingLand: 3000, bufferedEnd: 2666.5 });
    expect(p.landTo).toBeNull();
    expect(p.clearLand).toBe(false);
    expect(p.burnOneShot).toBe(false);
    expect(p.nudgeTo).toBeNull();
  });

  it("does nothing at all once the pipeline has painted", () => {
    const p = planFirstAppend({ ...base, painted: true });
    expect(p.nudgeTo).toBeNull();
    expect(p.burnOneShot).toBe(false);
  });

  it("still lands a late-arriving target after the pipeline has painted", () => {
    // Painting must not strand the landing seek.
    const p = planFirstAppend({ ...base, painted: true, pendingLand: 2666 });
    expect(p.landTo).toBe(2666);
    expect(p.clearLand).toBe(true);
  });

  it("never nudges while playing, because play() forces the decode", () => {
    const p = planFirstAppend({ ...base, paused: false });
    expect(p.nudgeTo).toBeNull();
  });

  it("steps a millisecond when currentTime already equals the origin", () => {
    // An assignment equal to the current time is not a seek and decodes
    // nothing, so it would paint nothing and emit no `seeked`.
    const p = planFirstAppend({ ...base, currentTime: 2661, bufferedStart: 2661 });
    expect(p.nudgeTo).toBeCloseTo(2661.001, 6);
  });

  it("does nothing before there is any buffered range", () => {
    const p = planFirstAppend({ ...base, hasBuffer: false, pendingLand: 2666 });
    expect(p).toEqual({ landTo: null, nudgeTo: null, clearLand: false, burnOneShot: false });
  });

  it("moves the picture and not the clock: the nudge targets the buffer origin", () => {
    // clockOrigin is subtracted back out in corrected(), so landing on
    // buffered.start(0) reports the same playhead it already reported.
    const p = planFirstAppend({ ...base, bufferedStart: 41.7, currentTime: 0 });
    expect(p.nudgeTo).toBe(41.7);
  });
});
