/**
 * The drawing tools, as geometry.
 *
 * One freehand pen is the wrong instrument for most review notes. "This corner"
 * is a rectangle, "look here" is an arrow, "this face" is an ellipse, and
 * "these three lines" is a highlighter you can still read the picture through.
 * Drawing those freehand is why annotations end up looking scrawled.
 *
 * Shapes are stored as the SAME normalised point list a freehand stroke uses —
 * two points, a drag from start to end — so nothing downstream changes: the
 * co-review op, the persisted doc, and a peer on an older build all keep
 * working, and an unknown tool degrades to the polyline through its points
 * rather than vanishing. That is the same additive discipline the `labels`
 * field and the pressure element already follow.
 */

export type DrawTool = "pen" | "highlighter" | "arrow" | "rect" | "ellipse";

export const DRAW_TOOLS: { id: DrawTool; label: string; hint: string }[] = [
  { id: "pen",         label: "Pen",         hint: "Freehand" },
  { id: "highlighter", label: "Highlighter", hint: "Translucent, wide" },
  { id: "arrow",       label: "Arrow",       hint: "Point at something" },
  { id: "rect",        label: "Rectangle",   hint: "Box an area" },
  { id: "ellipse",     label: "Ellipse",     hint: "Ring a face or detail" },
];

/** Tools that are a drag from A to B rather than a traced path. */
export function isShapeTool(t: DrawTool): boolean {
  return t === "arrow" || t === "rect" || t === "ellipse";
}

/**
 * Opacity per tool.
 *
 * A highlighter that is not translucent is just a fat pen — the whole point is
 * that the frame underneath stays readable, which is what a reviewer is
 * pointing AT.
 */
export function toolOpacity(t: DrawTool): number {
  return t === "highlighter" ? 0.35 : 1;
}

/** Width multiplier: a highlighter is broad, an arrow is a deliberate line. */
export function toolWidthScale(t: DrawTool): number {
  return t === "highlighter" ? 3 : 1;
}

type Pt = [number, number] | [number, number, number];

/**
 * Expand a two-point drag into the polyline a shape is drawn as.
 *
 * Returned in the same normalised space as freehand points, so the renderer
 * needs no special case and a peer that has never heard of "ellipse" still
 * paints the ring.
 */
export function shapePoints(tool: DrawTool, from: Pt, to: Pt): Pt[] {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const p = (x: number, y: number): Pt => [x, y, 0.5];

  if (tool === "rect") {
    return [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0)];
  }
  if (tool === "ellipse") {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
    // 48 segments: smooth at any size the canvas is ever drawn at, and still a
    // trivial payload beside a traced freehand stroke.
    const out: Pt[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      out.push(p(cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
    }
    return out;
  }
  if (tool === "arrow") {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    // Head scales with the shaft but is capped, so a long arrow across the
    // frame does not end in a head the size of a face.
    const head = Math.min(0.06, len * 0.28);
    const ux = dx / len, uy = dy / len;
    const back = (ang: number): Pt => {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      return p(x1 - head * (ux * ca - uy * sa), y1 - head * (ux * sa + uy * ca));
    };
    // Shaft, then out to one barb, back to the tip, out to the other — one
    // continuous path, because the stroke model is a single polyline.
    return [p(x0, y0), p(x1, y1), back(Math.PI / 7), p(x1, y1), back(-Math.PI / 7)];
  }
  return [from, to];
}
