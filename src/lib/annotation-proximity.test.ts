import { describe, expect, it } from "vitest";
import { annotationsNear, shouldReleasePin } from "./annotation-proximity";

const a = (time: number, color?: string) => ({ time, color });

describe("annotationsNear", () => {
  it("returns EVERY drawing in the window, not just the nearest", () => {
    // The bug: two people annotating the same moment, one silently dropped.
    const out = annotationsNear([a(10, "#f00"), a(10.05, "#0f0")], 10, 0.6);
    expect(out).toHaveLength(2);
  });

  it("paints furthest first, so the nearest reads on top", () => {
    const out = annotationsNear([a(10), a(10.4)], 10, 0.6);
    expect(out.map((x) => x.time)).toEqual([10.4, 10]);
  });

  it("fades with distance, solid at the exact frame", () => {
    const [far, near] = annotationsNear([a(10), a(10.3)], 10, 0.6);
    expect(near.opacity).toBeCloseTo(1, 5);
    expect(far.opacity).toBeCloseTo(0.5, 5);
  });

  it("drops anything outside the window", () => {
    expect(annotationsNear([a(10), a(20)], 10, 0.6).map((x) => x.time)).toEqual([10]);
  });

  it("breaks ties on time then colour, never on input order", () => {
    // Document order can change under a render; depth must not flicker.
    const forward = annotationsNear([a(10, "#aaa"), a(10, "#bbb")], 10, 0.6);
    const reversed = annotationsNear([a(10, "#bbb"), a(10, "#aaa")], 10, 0.6);
    expect(forward.map((x) => x.color)).toEqual(reversed.map((x) => x.color));
  });

  it("keeps the NEAREST when it has to drop some", () => {
    const many = [a(10), a(10.1), a(10.2), a(10.3), a(10.4), a(10.5)];
    const out = annotationsNear(many, 10, 0.6, 2);
    expect(out).toHaveLength(2);
    // Furthest-first order means the kept pair is the closest pair.
    expect(out.map((x) => x.time)).toEqual([10.1, 10]);
  });

  it("an empty window or no annotations yields nothing", () => {
    expect(annotationsNear([a(10)], 10, 0)).toEqual([]);
    expect(annotationsNear([], 10, 0.6)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [a(10, "#f00")];
    const copy = JSON.parse(JSON.stringify(input));
    annotationsNear(input, 10, 0.6);
    expect(input).toEqual(copy);
  });
});

/**
 * Letting a pinned drawing go.
 *
 * Reported as "the drawing is persistent across all frames. It really should
 * be persistent only on maybe a 5-second interval where it was drawn, and it
 * kind of fades away." The fade already existed (annotationsNear above) but
 * was ±0.6s, fourteen frames at 24fps, so a passing note was invisible unless
 * you parked on it. And a drawing opened from a comment was PINNED with no
 * release at all, so it painted over the entire timeline from then on.
 */
describe("a pinned drawing lets go once you scrub away", () => {
  const RELEASE = 6;

  it("holds while you are still near the frame you opened", () => {
    // Studying a note means nudging around it. That must not throw it away.
    for (const at of [100, 100.5, 103, 105.9, 94.1]) {
      expect(shouldReleasePin(at, 100, RELEASE), `${at}`).toBe(false);
    }
  });

  it("releases once you have genuinely left", () => {
    for (const at of [107, 200, 0, 5000]) {
      expect(shouldReleasePin(at, 100, RELEASE), `${at}`).toBe(true);
    }
  });

  it("is symmetric: scrubbing backwards releases too", () => {
    expect(shouldReleasePin(93, 100, RELEASE)).toBe(true);
    expect(shouldReleasePin(107, 100, RELEASE)).toBe(true);
  });

  it("never releases a pin that has no home to leave", () => {
    // A drawing opened with no time attached is a deliberate, manual pin.
    // Releasing it on a rule it was never given would make Hide the only
    // way it ever appears to work, at random.
    expect(shouldReleasePin(4000, null, RELEASE)).toBe(false);
    expect(shouldReleasePin(4000, undefined, RELEASE)).toBe(false);
  });

  it("does not release on a playhead it cannot read", () => {
    // NaN is what an unseeded playhead store reads as on the first beat.
    // `NaN > x` is false, so this is already the behaviour; it is pinned
    // because the opposite would dismiss every drawing at mount.
    expect(shouldReleasePin(NaN, 100, RELEASE)).toBe(false);
    expect(shouldReleasePin(100, NaN, RELEASE)).toBe(false);
  });

  it("is wider than the fade, because they answer different questions", () => {
    // The fade asks "is a drawing near enough to glimpse". This asks "have
    // you left the thing you opened". A release inside the fade window would
    // make an opened drawing vanish while still visibly fading.
    const FADE = 2.5;
    expect(RELEASE).toBeGreaterThan(FADE);
    expect(shouldReleasePin(100 + FADE, 100, RELEASE)).toBe(false);
  });
});
