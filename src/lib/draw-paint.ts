import { getStroke } from "perfect-freehand";
import { shapeGeometry } from "./draw-tools";
import type { AnnotationStrokes } from "./review";

/**
 * ONE painter for every surface that draws a stroke.
 *
 * This was a closure inside AnnotationOverlay's `redraw`, which was correct
 * while exactly one component painted strokes. Live telestration paints the
 * same strokes on a second canvas, and a second copy of this logic would be a
 * second place to get `dpr`, the no-simulated-pressure decision and the shape
 * geometry right. The comments below are load-bearing history: read them
 * before changing a constant.
 *
 * `alpha` is the only thing the live layer adds - it multiplies the stroke's
 * OWN opacity so a fading highlighter still reads as a highlighter, rather
 * than replacing it and turning every tool into a pen at 35%.
 */

export type PaintableStroke = AnnotationStrokes["strokes"][number];

/** How long a live mark's fade-out takes once its hold has expired. */
export const LIVE_FADE_OUT_MS = 900;

/**
 * Opacity of a live telestration mark, by how long THIS machine has had it.
 *
 * Pure so the behaviour is testable without a canvas or a clock: the fade is
 * the feature, and a fade that never reaches 0 leaks strokes for the session
 * while one that starts at <1 makes a fresh mark look stale.
 *
 * `holdMs <= 0` means "hold until cleared", which is a setting, not a bug.
 */
export function liveStrokeAlpha(ageMs: number, holdMs: number): number {
  if (holdMs <= 0) return 1;
  if (ageMs <= holdMs) return 1;
  const a = 1 - (ageMs - holdMs) / LIVE_FADE_OUT_MS;
  return a > 0 ? a : 0;
}

/** perfect-freehand outline → a smooth filled Path2D (midpoint-quadratic). */
function outlineToPath(outline: number[][]): Path2D {
  const path = new Path2D();
  if (outline.length < 2) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

export function paintStroke(
  ctx: CanvasRenderingContext2D,
  s: PaintableStroke,
  w: number,
  h: number,
  dpr: number,
  opts: { inProgress?: boolean; alpha?: number } = {},
): void {
  const inProgress = opts.inProgress ?? false;
  const alpha = opts.alpha ?? 1;
  if (alpha <= 0) return;
    if (s.pts.length === 0) return;
    // A SHAPE IS NOT HANDWRITING. Stroked as geometry, so a rectangle has
    // right angles and an arrow has a point. Everything below this is the
    // freehand path, and smoothing there is correct.
    if (s.shape) {
      const g = shapeGeometry(s.shape.kind, s.shape.from, s.shape.to, w, h);
      const prevA = ctx.globalAlpha;
      ctx.globalAlpha = (s.opacity ?? 1) * alpha;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = Math.max(1, s.size) * (s.widthScale ?? 1) * dpr;
      // Miter, so a corner is a corner. A round join is part of what
      // softened these into lozenges.
      ctx.lineJoin = "miter";
      ctx.lineCap = "butt";
      ctx.beginPath();
      if (g.kind === "rect") ctx.rect(g.x, g.y, g.w, g.h);
      else if (g.kind === "ellipse") ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2);
      else { ctx.moveTo(g.shaft[0][0], g.shaft[0][1]); ctx.lineTo(g.shaft[1][0], g.shaft[1][1]); }
      ctx.stroke();
      if (g.kind === "arrow") {
        ctx.beginPath();
        ctx.moveTo(g.head[0][0], g.head[0][1]);
        ctx.lineTo(g.head[1][0], g.head[1][1]);
        ctx.lineTo(g.head[2][0], g.head[2][1]);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = prevA;
      return;
    }
    // Pressure rides along when the pen gave us one; 0.5 is the neutral
    // middle for everything else, which keeps a mouse line even.
    const input = s.pts.map((pt) => [pt[0] * w, pt[1] * h, pt[2] ?? 0.5]);
    const outline = getStroke(input, {
      // `* dpr` is CORRECT and not a bug: the points above are in
      // backing-store pixels, so the size must be too, and multiplying by dpr
      // is what makes the slider value mean CSS pixels on screen.
      size: Math.max(1, s.size) * (s.widthScale ?? 1) * dpr,
      // NO SIMULATED PRESSURE. This was the blob.
      //
      // `norm` records position only, so with simulatePressure the width came
      // from perfect-freehand's VELOCITY heuristic — drag fast and the stroke
      // balloons, pause and it pinches. On a mouse that is not expression, it
      // is a readout of how fast your hand moved, and at thinning 0.6 it
      // swung the width across most of its range: one gesture came out as a
      // lumpy sausage with bulbous ends. A review annotation wants to read as
      // a deliberate mark, so an even line is the correct default and real
      // pressure (pen only, captured in `norm`) is the only thing allowed to
      // vary it.
      simulatePressure: false,
      // Gentle, so a pen still shows dynamics without the sausage.
      thinning: 0.35,
      // Higher than before: these are freehand circles and arrows drawn over
      // video with a trackpad, where the input is jittery and the intent is
      // smooth.
      smoothing: 0.72,
      streamline: 0.68,
      // A stroke still under the pen is not "last": perfect-freehand
// tapers a finished stroke and must not taper a growing one.
        last: !inProgress,
    });
    // Opacity rides the stroke, not the toolbar: a saved highlighter must
    // still read as a highlighter when someone opens the note tomorrow.
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = (s.opacity ?? 1) * alpha;
    ctx.fillStyle = s.color;
    ctx.fill(outlineToPath(outline));
    ctx.globalAlpha = prev;
}
