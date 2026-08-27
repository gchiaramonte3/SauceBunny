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
    // POINTS ALONG THE EDGES, not just the corners.
    //
    // Four corners and a close is a mathematically complete rectangle and a
    // useless input to perfect-freehand, which runs at smoothing 0.72 and
    // streamline 0.68: given five widely-spaced points it rounds straight
    // through every corner and returns a pointed oval. Drawing a box produced
    // a leaf.
    //
    // The ellipse beside this has always emitted 49 points and has always
    // looked right, which is the same fix arrived at from the other
    // direction: a smoothed stroke follows the points it is GIVEN, so an
    // outline has to be sampled, not merely described.
    const corners: Pt[] = [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)];
    const out: Pt[] = [];
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i];
      const [bx, by] = corners[(i + 1) % 4];
      // Step along the edge in normalised units, so a long edge gets more
      // samples than a short one and a tiny box is not over-sampled. The
      // floor of 8 keeps the corners tight on even the smallest rectangle.
      const steps = Math.max(8, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.01));
      // `< steps`, so the edge's end point is the next edge's start and no
      // point is emitted twice - a doubled point is a hitch in the outline.
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        out.push(p(ax + (bx - ax) * t, ay + (by - ay) * t));
      }
    }
    out.push(p(x0, y0)); // close the loop
    return out;
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

    // SAMPLED, for the same reason the rectangle above is.
    //
    // This used to return the five points that describe an arrow: shaft, barb,
    // tip, barb. Mathematically complete, and a useless input to
    // perfect-freehand at smoothing 0.72 / streamline 0.68 - it rounded
    // straight through both barbs and returned a gently curved line. The
    // arrow tool drew something indistinguishable from the pen, which is
    // exactly what the rectangle did before it was sampled ("drawing a box
    // produced a leaf").
    //
    // A smoothed stroke follows the points it is GIVEN, so the head has to be
    // traced rather than described.
    const seg = (a: Pt, b: Pt, out: Pt[], includeEnd: boolean) => {
      const [ax, ay] = a;
      const [bx, by] = b;
      // Same normalised step as the rectangle, with a floor so a short barb
      // still gets enough samples to hold its angle.
      const steps = Math.max(6, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.01));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        out.push(p(ax + (bx - ax) * t, ay + (by - ay) * t));
      }
      if (includeEnd) out.push(p(bx, by));
    };

    const tip = p(x1, y1);
    const out: Pt[] = [];
    seg(p(x0, y0), tip, out, true);      // shaft, ending exactly at the tip
    seg(tip, back(Math.PI / 7), out, true);   // out to one barb
    seg(back(Math.PI / 7), tip, out, true);   // back to the tip
    seg(tip, back(-Math.PI / 7), out, true);  // out to the other
    return out;
  }
  return [from, to];
}

/**
 * A shape as real geometry - not as handwriting.
 *
 * The shape tools used to be sampled into a polyline and pushed through
 * perfect-freehand, whose smoothing (0.72) and streamlining (0.68) exist to
 * make a traced pen line look natural. Applied to a rectangle they round every
 * corner and bow every edge: a box came out as a lozenge, and an arrow came
 * out as a gently curved line with no head. Sampling the outline more densely
 * was the wrong fix and did not work, because the smoothing is applied to
 * whatever it is handed.
 *
 * Returns plain DATA rather than a Path2D so the geometry is testable without
 * a DOM - Path2D exists in neither node nor jsdom, and a shape that cannot be
 * checked is how the first version of this shipped bent.
 *
 * Coordinates come in normalised and go out in canvas pixels.
 */
export type ShapeGeom =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | {
      kind: "arrow";
      /** Stops short of the tip, so the fill is not sitting on a line cap. */
      shaft: [[number, number], [number, number]];
      /** The head, as a filled triangle: sharp at every width, where three
       *  more stroked lines would read as a blob at small sizes. */
      head: [[number, number], [number, number], [number, number]];
    };

export function shapeGeometry(
  kind: "arrow" | "rect" | "ellipse",
  from: Pt,
  to: Pt,
  w: number,
  h: number,
): ShapeGeom {
  const x0 = from[0] * w, y0 = from[1] * h;
  const x1 = to[0] * w, y1 = to[1] * h;

  if (kind === "rect") {
    return {
      kind: "rect",
      x: Math.min(x0, x1), y: Math.min(y0, y1),
      w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
    };
  }
  if (kind === "ellipse") {
    return {
      kind: "ellipse",
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      rx: Math.abs(x1 - x0) / 2, ry: Math.abs(y1 - y0) / 2,
    };
  }

  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  // Scales with the shaft and is capped, so a long arrow does not end in a
  // head the size of a face.
  const head = Math.min(Math.min(w, h) * 0.06, len * 0.28);
  const barb = (ang: number): [number, number] => {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    return [x1 - head * (ux * ca - uy * sa), y1 - head * (ux * sa + uy * ca)];
  };
  return {
    kind: "arrow",
    shaft: [[x0, y0], [x1 - ux * head * 0.6, y1 - uy * head * 0.6]],
    head: [[x1, y1], barb(Math.PI / 7), barb(-Math.PI / 7)],
  };
}
