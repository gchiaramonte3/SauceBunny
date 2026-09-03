// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LiveDrawLayer } from "./LiveDrawLayer";
import type { DrawState, DrawStroke } from "../lib/draw-ops";

/**
 * The live-draw layer must not paint when there is nothing to paint.
 *
 * It is mounted for the WHOLE session, pen or no pen. Its first version
 * re-scheduled its rAF unconditionally, so an idle room cleared a
 * device-pixel-sized canvas every frame for the length of the session - a cost
 * paid by everything else on the stage, with nothing on screen to suggest why.
 * The reported symptom was that scrubbing a web source felt slower inside a
 * session than the same scrub in the clip panel, which mounts no such layer.
 *
 * These drive the real rAF queue rather than asserting on source text: the
 * property that matters is "does it schedule another frame", which only the
 * running component can answer.
 */

let root: Root | null = null;
let host: HTMLDivElement;
/** Pending rAF callbacks, newest last. */
let queue: FrameRequestCallback[];
let clears = 0;

/** Run every frame currently queued, once. Frames scheduled BY those frames
 *  land in the next batch, which is exactly what we are measuring. */
function pump(): number {
  const batch = queue;
  queue = [];
  act(() => { for (const cb of batch) cb(performance.now()); });
  return batch.length;
}

beforeEach(() => {
  queue = [];
  clears = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { queue.push(cb); return queue.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  // draw-paint builds real Path2D geometry, which jsdom does not implement.
  vi.stubGlobal("Path2D", class {
    moveTo() {} lineTo() {} closePath() {} quadraticCurveTo() {} bezierCurveTo() {} arc() {}
  });
  // jsdom canvases have no 2D context; the layer must get one or it bails for
  // the wrong reason and the test would pass vacuously.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    clearRect: () => { clears += 1; },
    drawImage: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    stroke: () => {}, fill: () => {}, closePath: () => {}, arc: () => {},
    save: () => {}, restore: () => {}, setTransform: () => {}, quadraticCurveTo: () => {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});

function render(state: DrawState) {
  act(() => {
    root = createRoot(host);
    root.render(<LiveDrawLayer state={state} fadeSec={4} onExpire={() => {}} />);
  });
}

const stroke = (id: string): DrawStroke => ({
  id, color: "#fff", size: 4, at: Date.now(), author: "Ana",
  pts: [[0.1, 0.1], [0.2, 0.2]] as [number, number][],
});
const state = (strokes: DrawStroke[]): DrawState => ({ strokes, erased: [] });

describe("LiveDrawLayer, idle cost", () => {
  it("schedules NO frames at all while the room has drawn nothing", () => {
    render(state([]));
    // The whole defect in one assertion: an empty layer that schedules even
    // one frame schedules them for ever, because each frame queues the next.
    expect(queue.length, "an idle layer scheduled a paint frame").toBe(0);
    expect(clears, "an idle layer cleared the canvas").toBe(0);
  });

  it("keeps painting while a stroke is alive", () => {
    render(state([stroke("a")]));
    expect(queue.length, "a live stroke was never scheduled for paint").toBe(1);
    // Three consecutive batches, each one scheduled by the previous frame.
    for (let i = 0; i < 3; i += 1) {
      expect(pump(), "the loop stopped while a stroke was still alive").toBe(1);
    }
    expect(clears).toBeGreaterThanOrEqual(3);
  });

  it("stops once the strokes are gone, after clearing what it drew", () => {
    render(state([stroke("a")]));
    pump();
    const before = clears;
    // The owner drops the faded stroke; the layer must clear once and stop.
    act(() => { root?.render(<LiveDrawLayer state={state([])} fadeSec={4} onExpire={() => {}} />); });
    pump();
    expect(clears, "the last mark was never cleared off the canvas").toBeGreaterThan(before);
    expect(queue.length, "the loop kept running with nothing to paint").toBe(0);
  });

  it("wakes again when a new stroke arrives after going idle", () => {
    render(state([]));
    expect(queue.length).toBe(0);
    act(() => { root?.render(<LiveDrawLayer state={state([stroke("b")])} fadeSec={4} onExpire={() => {}} />); });
    expect(queue.length, "a stroke drawn after the layer idled never painted").toBe(1);
  });
});
