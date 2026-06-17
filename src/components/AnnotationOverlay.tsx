import { useEffect, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import type { AnnotationStrokes } from "../lib/review";

/**
 * Free-hand drawing surface over the monitor — the Frame.io "draw on the frame"
 * gesture. Two modes from one component:
 *   • drawing → captures pointer strokes (perfect-freehand: smooth, tapered,
 *     velocity-pressured), reports them up via onChange.
 *   • display → renders a saved annotation read-only over the current frame at a
 *     parent-controlled `opacity` (so it can fade in/out as the playhead nears
 *     the comment's timecode). Pointer-transparent so the video stays clickable.
 *
 * Points are normalized 0..1 against the canvas so a drawing made at one monitor
 * size still lines up after a window/panel resize.
 */
const PEN_COLORS = [
  "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#5ac8fa",
  "#007aff", "#af52de", "#ff2d92", "#ffffff", "#1c1c1e",
];
const MIN_SIZE = 2;
const MAX_SIZE = 40;

type Stroke = AnnotationStrokes["strokes"][number];

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

export function AnnotationOverlay({
  annotation, drawing, opacity = 1, onChange, onDismiss,
}: {
  /** Strokes to render (the live draft while drawing, or a saved one to view). */
  annotation: AnnotationStrokes | null;
  /** True = capture pointer input; false = read-only display. */
  drawing: boolean;
  /** Read-only display opacity 0..1 (parent fades it by playhead proximity). */
  opacity?: number;
  /** Fired after each committed stroke (or a clear) while drawing. */
  onChange: (a: AnnotationStrokes) => void;
  /** Hide the read-only display (only shown for an explicitly-pinned drawing). */
  onDismiss?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const live = useRef<Stroke | null>(null);
  const [color, setColor] = useState(PEN_COLORS[0]);
  const [size, setSize] = useState(8);

  const strokes = annotation?.strokes ?? [];

  const redraw = () => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const w = cv.width, h = cv.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);
    const paint = (s: Stroke) => {
      if (s.pts.length === 0) return;
      const input = s.pts.map(([nx, ny]) => [nx * w, ny * h]);
      const outline = getStroke(input, {
        size: Math.max(1, s.size) * dpr,
        thinning: 0.6,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: true,
        last: s !== live.current,
      });
      ctx.fillStyle = s.color;
      ctx.fill(outlineToPath(outline));
    };
    strokes.forEach(paint);
    if (live.current) paint(live.current);
  };

  // Keep the backing store sized to the displayed canvas (DPR-aware) + redraw.
  useEffect(() => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
      cv.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
      redraw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    // Dragging between mixed-DPR displays changes devicePixelRatio at constant
    // CSS size, which the ResizeObserver won't catch — refit on a resolution
    // change too. The query is value-specific, so re-arm it each time it fires.
    let mq: MediaQueryList | null = null;
    const onDpr = () => { fit(); arm(); };
    const arm = () => {
      mq?.removeEventListener("change", onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener("change", onDpr);
    };
    arm();
    return () => { ro.disconnect(); mq?.removeEventListener("change", onDpr); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw when the committed strokes change (annotation swapped / cleared).
  // The live draft is repainted imperatively from onDown/onMove/onUp, and the
  // mount/resize redraw is handled by the fit() effect — so this must NOT run on
  // every render (a deps-less effect re-rasterized the whole drawing on every
  // playhead tick during a proximity fade; opacity is a CSS-only wrapper concern).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(redraw, [annotation]);

  const norm = (e: React.PointerEvent): [number, number] => {
    const r = (canvasRef.current as HTMLCanvasElement).getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  };

  const onDown = (e: React.PointerEvent) => {
    if (!drawing) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    live.current = { color, size, pts: [norm(e)] };
    redraw();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawing || !live.current) return;
    live.current.pts.push(norm(e));
    redraw();
  };
  const onUp = () => {
    if (!drawing || !live.current) return;
    const finished = live.current;
    live.current = null;
    if (finished.pts.length > 0) onChange({ strokes: [...strokes, finished] });
  };

  // Read-only with nothing to show (or fully faded) → render nothing.
  if (!drawing && (strokes.length === 0 || opacity <= 0)) return null;

  return (
    <div
      ref={wrapRef}
      className={"cp-annot" + (drawing ? " drawing" : "")}
      style={{ pointerEvents: drawing ? "auto" : "none", opacity: drawing ? 1 : opacity }}
    >
      <canvas
        ref={canvasRef}
        className="cp-annot-canvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onPointerCancel={onUp}
      />
      {drawing ? (
        <div className="cp-annot-tools">
          <div className="cp-annot-swatches">
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                className={"cp-annot-swatch" + (c === color ? " active" : "")}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={c}
                aria-label={`Pen color ${c}`}
              />
            ))}
            <label className="cp-annot-custom" title="Custom color">
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          </div>
          <span className="cp-annot-divider" />
          <div className="cp-annot-sizectl" title="Brush size">
            <span className="cp-annot-dot" style={{ width: Math.max(3, size / 2), height: Math.max(3, size / 2), background: color }} />
            <input
              type="range" min={MIN_SIZE} max={MAX_SIZE} step={1} value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              aria-label="Brush size"
            />
          </div>
          <span className="cp-annot-divider" />
          <button
            className="cp-annot-clear"
            onClick={() => { live.current = null; onChange({ strokes: [] }); }}
            disabled={strokes.length === 0}
          >
            Clear
          </button>
        </div>
      ) : onDismiss ? (
        <button className="cp-annot-hide" style={{ pointerEvents: "auto" }} onClick={onDismiss}>
          Hide drawing
        </button>
      ) : null}
    </div>
  );
}
