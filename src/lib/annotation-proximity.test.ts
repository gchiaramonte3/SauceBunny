import { describe, expect, it } from "vitest";
import { annotationsNear } from "./annotation-proximity";

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
