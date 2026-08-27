import { describe, expect, it } from "vitest";
import { getStroke } from "perfect-freehand";
import {
  DRAW_TOOLS, isShapeTool, shapePoints, toolOpacity, toolWidthScale, type DrawTool, shapeGeometry } from "./draw-tools";

/**
 * Shapes are stored as ordinary normalised point lists, which is the whole
 * design: nothing downstream learns a new format, and a peer that has never
 * heard of "ellipse" still paints the ring as a polyline instead of dropping
 * the annotation.
 */
const A: [number, number] = [0.2, 0.2];
const B: [number, number] = [0.8, 0.6];
const inRange = (pts: [number, number, number][] | ReturnType<typeof shapePoints>) =>
  pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

describe("drawing tools", () => {
  it("offers a tool for each thing a reviewer actually says", () => {
    expect(DRAW_TOOLS.map((t) => t.id)).toEqual(["pen", "highlighter", "arrow", "rect", "ellipse"]);
    for (const t of DRAW_TOOLS) expect(t.label.length, t.id).toBeGreaterThan(0);
  });

  it("knows which tools are a drag rather than a traced path", () => {
    expect(isShapeTool("pen")).toBe(false);
    expect(isShapeTool("highlighter")).toBe(false);
    for (const t of ["arrow", "rect", "ellipse"] as DrawTool[]) expect(isShapeTool(t)).toBe(true);
  });

  it("makes the highlighter translucent and wide, and nothing else", () => {
    // A highlighter that is not see-through is just a fat pen, and the frame
    // underneath is the thing being pointed at.
    expect(toolOpacity("highlighter")).toBeLessThan(1);
    expect(toolWidthScale("highlighter")).toBeGreaterThan(1);
    for (const t of ["pen", "arrow", "rect", "ellipse"] as DrawTool[]) {
      expect(toolOpacity(t), t).toBe(1);
      expect(toolWidthScale(t), t).toBe(1);
    }
  });

  it("closes a rectangle, so it reads as a box and not an L", () => {
    // This used to assert exactly five points, which is a complete
    // description of a rectangle and a useless INPUT to a smoothed stroke -
    // perfect-freehand rounded straight through the corners and returned a
    // pointed oval. The count is no longer the promise; the closed loop is.
    const pts = shapePoints("rect", A, B);
    const last = pts[pts.length - 1];
    expect([pts[0][0], pts[0][1]]).toEqual([last[0], last[1]]);
    expect(inRange(pts)).toBe(true);
  });

  it("draws an ellipse that is closed and inside its drag box", () => {
    const pts = shapePoints("ellipse", A, B);
    expect(pts.length).toBeGreaterThan(24);
    expect(inRange(pts)).toBe(true);
    const xs = pts.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0.2, 5);
    expect(Math.max(...xs)).toBeCloseTo(0.8, 5);
  });

  it("puts the arrow head at the END, where you released", () => {
    const pts = shapePoints("arrow", A, B);
    // The path REACHES the tip. Asserted by geometry rather than by index:
    // the old version pinned pts[1] and a length of 5, which is a claim about
    // the representation, and it is what let the head be smoothed away while
    // the test stayed green.
    const near = pts.filter((q) => Math.hypot(q[0] - B[0], q[1] - B[1]) < 1e-9);
    expect(near.length, "the path never reaches the point you released at").toBeGreaterThan(0);
  });

  it("SURVIVES SMOOTHING, which is the whole reason it is sampled", () => {
    // THE BUG THIS FILE MISSED. shapePoints returned the five points that
    // describe an arrow, and perfect-freehand at smoothing 0.72 / streamline
    // 0.68 rounded straight through both barbs: the arrow tool drew a gently
    // curved line indistinguishable from the pen. The rectangle hit the same
    // trap first ("drawing a box produced a leaf") and was fixed by sampling.
    //
    // So this measures the RENDERED outline, with the app's own settings,
    // rather than the point list. A head is a place where the stroke is much
    // wider than the shaft.
    const pts = shapePoints("arrow", [0.2, 0.5], [0.8, 0.5]);
    const outline = getStroke(pts.map((q) => [q[0] * 1000, q[1] * 1000, q[2] ?? 0.5]), {
      size: 8, thinning: 0.55, smoothing: 0.72, streamline: 0.68, simulatePressure: false,
    });
    // Vertical spread of the outline near the tip against near the middle of
    // the shaft. With barbs, the tip end is dramatically taller.
    const spreadNear = (x: number) => {
      const ys = outline.filter((o) => Math.abs(o[0] - x) < 25).map((o) => o[1]);
      return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
    };
    const atShaft = spreadNear(400);
    const atHead = spreadNear(780);
    expect(atShaft, "the shaft did not render at all").toBeGreaterThan(0);
    expect(
      atHead,
      `no head survived smoothing: shaft spread ${atShaft.toFixed(1)}, head spread ${atHead.toFixed(1)}`,
    ).toBeGreaterThan(atShaft * 3);
  });

  it("caps the arrow head so a long arrow is not all head", () => {
    const spread = (from: [number, number], to: [number, number]) => {
      const pts = shapePoints("arrow", from, to);
      // Furthest any point strays from the straight shaft line: that IS the
      // head, however the polyline happens to be ordered.
      const [ax, ay] = from, [bx, by] = to;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      return Math.max(...pts.map((q) =>
        Math.abs((bx - ax) * (ay - q[1]) - (ax - q[0]) * (by - ay)) / len));
    };
    expect(spread([0.5, 0.5], [0.52, 0.5])).toBeLessThan(spread([0.02, 0.5], [0.98, 0.5]));
    expect(spread([0.02, 0.5], [0.98, 0.5])).toBeLessThanOrEqual(0.07);
  });

  it("survives a zero-length drag without producing NaN", () => {
    // A click without a drag: len is 0, and dividing by it would poison every
    // point and paint nothing, silently.
    for (const t of ["arrow", "rect", "ellipse"] as DrawTool[]) {
      expect(inRange(shapePoints(t, [0.5, 0.5], [0.5, 0.5])), t).toBe(true);
    }
  });

  it("degrades an unknown tool to the plain segment it was drawn as", () => {
    // Forward compatibility with a peer on a newer build.
    const pts = shapePoints("lasso" as DrawTool, A, B);
    expect(pts).toEqual([A, B]);
  });
});

describe("the rectangle is sampled, not just described", () => {
  // Four corners and a close is a complete rectangle and a useless input to
  // perfect-freehand, which runs at smoothing 0.72 / streamline 0.68: given
  // five sparse points it rounds through every corner and returns a pointed
  // oval. Drawing a box produced a leaf.
  const pts = shapePoints("rect", [0.2, 0.2, 0.5], [0.8, 0.6, 0.5]);

  const onEdge = ([x, y]: readonly number[]): boolean => {
    const e = 1e-9;
    const inX = x >= 0.2 - e && x <= 0.8 + e;
    const inY = y >= 0.2 - e && y <= 0.6 + e;
    const onVert = (Math.abs(x - 0.2) < e || Math.abs(x - 0.8) < e) && inY;
    const onHorz = (Math.abs(y - 0.2) < e || Math.abs(y - 0.6) < e) && inX;
    return onVert || onHorz;
  };

  it("emits enough points for a smoothed stroke to follow the edges", () => {
    // The ellipse has always emitted 49 and has always looked right.
    expect(pts.length).toBeGreaterThan(40);
  });

  it("every point lies exactly on the rectangle's outline", () => {
    // Densifying must not bow the edges - a sampled edge is still straight.
    expect(pts.every(onEdge)).toBe(true);
  });

  it("reaches all four corners", () => {
    const has = (x: number, y: number) =>
      pts.some((q) => Math.abs(q[0] - x) < 1e-9 && Math.abs(q[1] - y) < 1e-9);
    expect(has(0.2, 0.2) && has(0.8, 0.2) && has(0.8, 0.6) && has(0.2, 0.6)).toBe(true);
  });

  it("closes the loop and repeats no interior point", () => {
    expect(pts[pts.length - 1][0]).toBeCloseTo(pts[0][0], 12);
    expect(pts[pts.length - 1][1]).toBeCloseTo(pts[0][1], 12);
    // A doubled point is a hitch in the outline; only the closing one repeats.
    const seen = new Set(pts.slice(0, -1).map((q) => `${q[0]},${q[1]}`));
    expect(seen.size).toBe(pts.length - 1);
  });

  it("a tiny rectangle still gets tight corners", () => {
    const tiny = shapePoints("rect", [0.5, 0.5, 0.5], [0.51, 0.508, 0.5]);
    expect(tiny.length).toBeGreaterThanOrEqual(32);
  });
});

/**
 * Shapes are GEOMETRY, not handwriting.
 *
 * They used to be sampled into a polyline and pushed through perfect-freehand,
 * whose smoothing (0.72) and streamlining (0.68) exist to make a traced pen
 * line look natural. Applied to a rectangle that rounds every corner and bows
 * every edge: a box came out as a lozenge, and an arrow came out as a gently
 * curved line with no head at all.
 *
 * Sampling the outline more densely was the wrong fix and did not work,
 * because the smoothing is applied to whatever it is handed. These check the
 * real path instead.
 */
describe("shapes are geometry, not handwriting", () => {
  const W = 1000, H = 1000;

  it("gives a rectangle exact right angles at the drag's bounds", () => {
    const g = shapeGeometry("rect", [0.2, 0.3], [0.8, 0.7], W, H);
    expect(g).toEqual({ kind: "rect", x: 200, y: 300, w: 600, h: 400 });
  });

  it("normalises a rectangle dragged up and to the left", () => {
    // Dragging bottom-right to top-left is the same box. Negative width would
    // silently paint nothing.
    expect(shapeGeometry("rect", [0.8, 0.7], [0.2, 0.3], W, H))
      .toEqual({ kind: "rect", x: 200, y: 300, w: 600, h: 400 });
  });

  it("gives an ellipse a real centre and radii", () => {
    expect(shapeGeometry("ellipse", [0.2, 0.2], [0.6, 0.8], W, H))
      .toEqual({ kind: "ellipse", cx: 400, cy: 500, rx: 200, ry: 300 });
  });

  it("gives an arrow a HEAD, which is the thing that was missing", () => {
    const g = shapeGeometry("arrow", [0.2, 0.5], [0.8, 0.5], W, H);
    if (g.kind !== "arrow") throw new Error("not an arrow");
    // Three distinct points, one of them the tip you released at.
    expect(g.head[0]).toEqual([800, 500]);
    const spread = Math.hypot(g.head[1][0] - g.head[2][0], g.head[1][1] - g.head[2][1]);
    expect(spread, "the head has no width, so there is no head").toBeGreaterThan(10);
  });

  it("stops the shaft short of the tip, so the fill has a clean point", () => {
    const g = shapeGeometry("arrow", [0.2, 0.5], [0.8, 0.5], W, H);
    if (g.kind !== "arrow") throw new Error("not an arrow");
    expect(g.shaft[1][0], "the shaft runs to the tip and will poke through the head")
      .toBeLessThan(800);
  });

  it("caps the head so a long arrow is not all head", () => {
    const long = shapeGeometry("arrow", [0.02, 0.5], [0.98, 0.5], W, H);
    const short = shapeGeometry("arrow", [0.5, 0.5], [0.52, 0.5], W, H);
    if (long.kind !== "arrow" || short.kind !== "arrow") throw new Error("not arrows");
    const headLen = (g: typeof long) => Math.hypot(g.head[0][0] - g.head[1][0], g.head[0][1] - g.head[1][1]);
    expect(headLen(short)).toBeLessThan(headLen(long));
    expect(headLen(long)).toBeLessThanOrEqual(W * 0.07);
  });

  it("survives a zero-length drag without producing NaN", () => {
    // A click with no drag: len is 0 and dividing by it would poison the head
    // and paint nothing, silently.
    for (const k of ["arrow", "rect", "ellipse"] as const) {
      const g = shapeGeometry(k, [0.5, 0.5], [0.5, 0.5], W, H);
      for (const v of JSON.stringify(g).match(/-?\d+\.?\d*/g) ?? []) {
        expect(Number.isFinite(Number(v))).toBe(true);
      }
    }
  });
});
