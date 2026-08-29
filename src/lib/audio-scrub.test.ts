import { describe, expect, it } from "vitest";
import {
  GRAIN_CORE_SEC, GRAIN_FADE_SEC, GRAIN_MAX_VOICES, GRAIN_MIN_INTERVAL_MS,
  GRAIN_MIN_MOVE_SEC, idleScrubState, planGrain, type ScrubGrainState,
} from "./audio-scrub";

const DUR = 600;
const at = (ms: number, sec: number): ScrubGrainState => ({ lastFiredAtMs: ms, lastSourceSec: sec });

describe("audio scrub grain policy", () => {
  it("sounds the first grain immediately", () => {
    const g = planGrain(idleScrubState(), 1000, 10, DUR);
    expect(g).not.toBeNull();
    expect(g!.durationSec).toBeCloseTo(GRAIN_CORE_SEC, 6);
  });

  it("centres the grain on the playhead, not ahead of it", () => {
    const g = planGrain(idleScrubState(), 0, 10, DUR)!;
    expect(g.offsetSec).toBeCloseTo(10 - GRAIN_CORE_SEC / 2, 6);
  });

  it("goes SILENT when the playhead is standing still", () => {
    // The stuck-record case: time has passed, position has not.
    const s = at(0, 10);
    expect(planGrain(s, 500, 10, DUR)).toBeNull();
    expect(planGrain(s, 500, 10 + GRAIN_MIN_MOVE_SEC / 2, DUR)).toBeNull();
    // Move far enough and it speaks again.
    expect(planGrain(s, 500, 10 + GRAIN_MIN_MOVE_SEC * 2, DUR)).not.toBeNull();
  });

  it("rate-caps a fast drag instead of stacking voices without limit", () => {
    const s = at(0, 10);
    expect(planGrain(s, GRAIN_MIN_INTERVAL_MS - 1, 20, DUR)).toBeNull();
    expect(planGrain(s, GRAIN_MIN_INTERVAL_MS + 1, 20, DUR)).not.toBeNull();
  });

  it("never lets overlap raise the level: gain falls as the drag speeds up", () => {
    const slow = planGrain(at(0, 10), 400, 12, DUR)!;   // widely spaced
    const fast = planGrain(at(0, 10), GRAIN_MIN_INTERVAL_MS, 12, DUR)!; // tightest legal
    expect(slow.gain).toBeGreaterThan(fast.gain);
    expect(slow.gain).toBeLessThanOrEqual(1);
    expect(fast.gain).toBeGreaterThanOrEqual(1 / Math.sqrt(GRAIN_MAX_VOICES));
  });

  it("plays each grain FORWARD when scrubbing backwards", () => {
    // Backwards drag: the position steps back, the excerpt is still read
    // forward from an earlier offset. A negative duration would mean reversal.
    const g = planGrain(at(0, 10), 200, 8, DUR)!;
    expect(g.durationSec).toBeGreaterThan(0);
    expect(g.offsetSec).toBeCloseTo(8 - GRAIN_CORE_SEC / 2, 6);
  });

  it("cannot read past the end of the media", () => {
    const g = planGrain(idleScrubState(), 0, DUR, DUR)!;
    expect(g.offsetSec + g.durationSec).toBeLessThanOrEqual(DUR + 1e-9);
  });

  it("clamps a negative offset at the very start", () => {
    const g = planGrain(idleScrubState(), 0, 0.001, DUR)!;
    expect(g.offsetSec).toBeGreaterThanOrEqual(0);
  });

  it("keeps fades inside the grain", () => {
    const g = planGrain(idleScrubState(), 0, 10, DUR)!;
    expect(g.fadeSec * 2).toBeLessThanOrEqual(g.durationSec);
    expect(g.fadeSec).toBeCloseTo(GRAIN_FADE_SEC, 6);
  });

  it("shortens the fade rather than exceeding a short final grain", () => {
    const shortMedia = GRAIN_CORE_SEC / 4;
    const g = planGrain(idleScrubState(), 0, shortMedia, shortMedia);
    if (g) expect(g.fadeSec * 2).toBeLessThanOrEqual(g.durationSec + 1e-9);
  });

  it("refuses nonsense rather than scheduling it", () => {
    expect(planGrain(idleScrubState(), 0, NaN, DUR)).toBeNull();
    expect(planGrain(idleScrubState(), 0, -1, DUR)).toBeNull();
    expect(planGrain(idleScrubState(), 0, 10, 0)).toBeNull();
    expect(planGrain(idleScrubState(), 0, 10, NaN)).toBeNull();
  });

  it("treats a clock that did not advance as no time passed", () => {
    // Guards the gate against a backwards/frozen monotonic reading opening it.
    expect(planGrain(at(1000, 10), 1000, 20, DUR)).toBeNull();
    expect(planGrain(at(1000, 10), 900, 20, DUR)).toBeNull();
  });
});
