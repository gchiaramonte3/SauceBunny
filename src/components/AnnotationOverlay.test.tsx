// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AnnotationOverlay } from "./AnnotationOverlay";

/**
 * The stroke that came out as a lumpy sausage.
 *
 * `norm` recorded position only, so perfect-freehand was left to invent
 * pressure from VELOCITY (simulatePressure) — drag fast and the stroke
 * ballooned, pause and it pinched — and at thinning 0.6 that swung the width
 * across most of its range. One deliberate circle drawn over a video came out
 * as a bulbous blob. These pin the shape of the fix rather than the pixels:
 * pressure is captured, simulation is off, and old strokes still draw.
 */

const captured = vi.hoisted(() => ({ calls: [] as { input: number[][]; opts: Record<string, unknown> }[] }));
vi.mock("perfect-freehand", () => ({
  default: (input: number[][], opts: Record<string, unknown>) => {
    captured.calls.push({ input, opts });
    return [[0, 0], [1, 1], [2, 2]];
  },
  getStroke: (input: number[][], opts: Record<string, unknown>) => {
    captured.calls.push({ input, opts });
    return [[0, 0], [1, 1], [2, 2]];
  },
}));

// jsdom has no 2D context, and redraw() returns early without one — the first
// version of this file asserted against a canvas that never painted.
const ctx2d = {
  clearRect: () => {}, fill: () => {}, set fillStyle(_v: string) {},
} as unknown as CanvasRenderingContext2D;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx2d as never);
  // jsdom has no Path2D either; outlineToPath builds one per stroke.
  (globalThis as { Path2D?: unknown }).Path2D = class {
    moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {}
  };
});
afterEach(() => { cleanup(); captured.calls = []; vi.restoreAllMocks(); });

const draft = (pts: ([number, number] | [number, number, number])[]) => ({
  strokes: [{ color: "#f00", size: 6, pts }],
  labels: [],
});

function show(value: ReturnType<typeof draft>) {
  render(<AnnotationOverlay annotation={value} drawing onChange={() => {}} />);
}

describe("annotation strokes", () => {
  it("never asks perfect-freehand to invent pressure", () => {
    // The whole bug in one assertion: simulated pressure is a readout of hand
    // speed, not intent, and it is what made the blob.
    show(draft([[0.1, 0.1, 0.5], [0.2, 0.2, 0.5]]));
    const opts = captured.calls.at(-1)?.opts ?? {};
    expect(opts.simulatePressure, "velocity is driving the width again").toBe(false);
  });

  it("keeps thinning gentle, so a pen varies the line without swelling it", () => {
    show(draft([[0.1, 0.1, 0.5], [0.2, 0.2, 0.5]]));
    const opts = captured.calls.at(-1)?.opts ?? {};
    expect(typeof opts.thinning).toBe("number");
    expect(opts.thinning as number).toBeGreaterThan(0);
    expect(opts.thinning as number, "back to sausage territory").toBeLessThanOrEqual(0.45);
  });

  it("still renders strokes saved before pressure existed", () => {
    // Two-element points are what every previously saved annotation — and any
    // co-review peer on an older build — sends. They must draw, at a constant
    // width, rather than collapsing to nothing.
    show(draft([[0.1, 0.1], [0.9, 0.9]]));
    const input = captured.calls.at(-1)?.input ?? [];
    expect(input.length).toBe(2);
    for (const pt of input) {
      expect(pt).toHaveLength(3);
      expect(pt[2], "a legacy point lost its neutral pressure").toBe(0.5);
    }
  });

  it("carries a captured pressure through to the renderer", () => {
    show(draft([[0.1, 0.1, 0.9], [0.2, 0.2, 0.2]]));
    const input = captured.calls.at(-1)?.input ?? [];
    expect(input.map((p) => p[2])).toEqual([0.9, 0.2]);
  });
  // NOT TESTED HERE, deliberately: coalesced pointer samples.
  //
  // onMove reads e.nativeEvent.getCoalescedEvents(), which jsdom does not
  // implement and React's synthetic event will not carry faithfully — a test
  // would have to fake the very API under test and would pass whether or not
  // the code read it. That is the false-pass shape this file already avoids
  // elsewhere, so the behaviour is verified by drawing a fast stroke in the
  // app instead, and the reason it exists is written at the call site.
});
