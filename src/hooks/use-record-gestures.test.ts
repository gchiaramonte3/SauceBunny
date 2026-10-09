import { describe, expect, it } from "vitest";
import { edgeStep } from "./use-record-gestures";

describe("a drag held at the timeline's edge", () => {
  const box = { left: 100, right: 900 };
  it("scrolls only inside the edge band, faster the deeper the pointer goes, and at full speed past the edge", () => {
    expect(edgeStep(500, box)).toBe(0);
    expect(edgeStep(100 + 48, box)).toBe(0);
    expect(edgeStep(100 + 47, box)).toBeLessThan(0);
    expect(Math.abs(edgeStep(100 + 47, box))).toBeLessThan(Math.abs(edgeStep(110, box)));
    expect(edgeStep(100, box)).toBe(-14);
    // Past the edge it stays at full speed rather than slowing or turning round.
    expect(edgeStep(20, box)).toBe(-14);
    expect(edgeStep(900, box)).toBe(14);
    expect(edgeStep(2000, box)).toBe(14);
  });
  it("narrows the band on a narrow timeline, so the two edges never claim the same pixels", () => {
    const narrow = { left: 0, right: 100 };
    expect(edgeStep(50, narrow)).toBe(0);
    expect(edgeStep(10, narrow)).toBeLessThan(0);
    expect(edgeStep(90, narrow)).toBeGreaterThan(0);
  });
});
