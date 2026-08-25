import { describe, expect, it } from "vitest";
import {
  DRAW_TOOLS, isShapeTool, shapePoints, toolOpacity, toolWidthScale, type DrawTool,
} from "./draw-tools";

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
    expect([pts[1][0], pts[1][1]]).toEqual([0.8, 0.6]);
    // Barbs return to the tip between them, so the path is continuous.
    expect([pts[3][0], pts[3][1]]).toEqual([0.8, 0.6]);
    expect(pts).toHaveLength(5);
  });

  it("caps the arrow head so a long arrow is not all head", () => {
    const short = shapePoints("arrow", [0.5, 0.5], [0.52, 0.5]);
    const long = shapePoints("arrow", [0.02, 0.5], [0.98, 0.5]);
    const spread = (p: ReturnType<typeof shapePoints>) =>
      Math.hypot(p[1][0] - p[2][0], p[1][1] - p[2][1]);
    expect(spread(short)).toBeLessThan(spread(long));
    expect(spread(long)).toBeLessThanOrEqual(0.07);
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
