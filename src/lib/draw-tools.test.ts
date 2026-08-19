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
    const pts = shapePoints("rect", A, B);
    expect(pts).toHaveLength(5);
    expect([pts[0][0], pts[0][1]]).toEqual([pts[4][0], pts[4][1]]);
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
