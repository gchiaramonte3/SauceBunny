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

describe("the first-use canvas size", () => {
  /**
   * The pixelation bug, whole. The overlay mounts long before the first draw
   * (Monitor keeps it mounted with drawing=false and no annotation), and its
   * first render returns null. The canvas-sizing effect ran once, at mount,
   * against refs that were still empty - so when Draw flipped on and the
   * canvas finally appeared, NOTHING sized it. It kept the HTML default
   * 300x150 backing store, stretched by CSS across the whole monitor: an
   * ~8x upscale on retina, every stroke blocky, the smallest brush fat.
   *
   * The suite missed it because every case rendered with drawing already
   * true, which is the one order real usage never takes. This case takes
   * the real order: mount invisible, then start drawing.
   */
  it("sizes the backing store when the canvas appears AFTER mount", () => {
    const dpr = 2;
    vi.stubGlobal("devicePixelRatio", dpr);
    // jsdom reports 0 for clientWidth; the fit reads the wrapper, so give it
    // real dimensions the way the monitor's layout would.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(720);

    const { rerender, container } = render(
      <AnnotationOverlay annotation={null} drawing={false} onChange={() => {}} />,
    );
    // Nothing renders while there is nothing to show - that part was right.
    expect(container.querySelector("canvas")).toBeNull();

    rerender(<AnnotationOverlay annotation={null} drawing onChange={() => {}} />);
    const cv = container.querySelector("canvas") as HTMLCanvasElement;
    expect(cv, "drawing mode must mount the canvas").toBeTruthy();
    expect(cv.width, "the 300x150 default backing store shipped").toBe(1280 * dpr);
    expect(cv.height).toBe(720 * dpr);
  });
});
