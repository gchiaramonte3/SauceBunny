import { ColorSwatches } from "./ColorSwatches";
import { useEffect, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import {
  DRAW_TOOLS, isShapeTool, shapePoints, toolOpacity, toolWidthScale, type DrawTool,
} from "../lib/draw-tools";
import { annotationHasContent, type AnnotationStrokes } from "../lib/review";
import { AnnotationLabels } from "./review/AnnotationLabels";
import { LabelInput } from "./review/LabelInput";

/**
 * Free-hand drawing surface over the monitor — the Frame.io "draw on the frame"
 * gesture. Two modes from one component:
 *   • drawing → captures pointer strokes (perfect-freehand: smooth, tapered,
 *     velocity-pressured), reports them up via onChange. With `labelMode` on,
 *     a click places a text-label input instead of starting a stroke; Enter
 *     commits the label into the same annotation payload the strokes ride in.
 *   • display → renders a saved annotation read-only over the current frame at a
 *     parent-controlled `opacity` (so it can fade in/out as the playhead nears
 *     the comment's timecode). Pointer-transparent so the video stays clickable.
 *
 * Points are normalized 0..1 against the canvas so a drawing made at one monitor
 * size still lines up after a window/panel resize; label anchors use the same
 * space (chip positions scale, chip text stays a fixed readable size).
 */
const PEN_COLORS = [
  "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#5ac8fa",
  "#007aff", "#af52de", "#ff2d92", "#ffffff", "#1c1c1e",
];
const MIN_SIZE = 2;
// 40 was a marker, not a pen: at the top of the range one stroke covered a
// third of the frame. 24 still reads clearly over 1080p and no longer hides
// the thing being annotated.
const MAX_SIZE = 24;

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
  annotation, drawing, opacity = 1, onChange, onDismiss, labelMode = false, labelColor = "#4dabf7",
}: {
  /** Strokes to render (the live draft while drawing, or a saved one to view). */
  annotation: AnnotationStrokes | null;
  /** True = capture pointer input; false = read-only display. */
  drawing: boolean;
  /** Read-only display opacity 0..1 (parent fades it by playhead proximity). */
  opacity?: number;
  /** Fired after each committed stroke/label (or a clear) while drawing. */
  onChange: (a: AnnotationStrokes) => void;
  /** Hide the read-only display (only shown for an explicitly-pinned drawing). */
  onDismiss?: () => void;
  /** While drawing: clicks place text labels instead of pen strokes. */
  labelMode?: boolean;
  /** Reviewer colour for label chips (draft = current reviewer; saved = the
   *  comment author's) — defaults to the panel blue (AVATAR_COLORS[0]). */
  labelColor?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const live = useRef<Stroke | null>(null);
  const [color, setColor] = useState(PEN_COLORS[0]);
  // A review mark should sit ON the picture, not replace it.
  const [size, setSize] = useState(5);
  const [tool, setTool] = useState<DrawTool>("pen");
  /** Where a shape drag started; shapes are two points, not a traced path. */
  const shapeStart = useRef<[number, number, number] | null>(null);
  // In-progress label (label mode): anchor + text while the input is open.
  // Mirrored in a ref so the input's blur and a same-tick canvas click can't
  // both commit it (whichever runs second sees null and no-ops).
  const [pendingLabel, setPendingLabel] = useState<{ x: number; y: number; text: string } | null>(null);
  const pendingRef = useRef(pendingLabel);
  pendingRef.current = pendingLabel;

  const strokes = annotation?.strokes ?? [];
  const labels = annotation?.labels ?? [];

  const commitPendingLabel = () => {
    const p = pendingRef.current;
    if (!p) return;
    pendingRef.current = null;
    setPendingLabel(null);
    const text = p.text.trim();
    if (text) onChange({ strokes, labels: [...labels, { text, x: p.x, y: p.y }] });
  };
  const cancelPendingLabel = () => {
    pendingRef.current = null;
    setPendingLabel(null);
  };

  const redraw = () => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const w = cv.width, h = cv.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);
    const paint = (s: Stroke) => {
      if (s.pts.length === 0) return;
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
        last: s !== live.current,
      });
      // Opacity rides the stroke, not the toolbar: a saved highlighter must
      // still read as a highlighter when someone opens the note tomorrow.
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = s.opacity ?? 1;
      ctx.fillStyle = s.color;
      ctx.fill(outlineToPath(outline));
      ctx.globalAlpha = prev;
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

  const norm = (e: React.PointerEvent): [number, number, number] => {
    const r = (canvasRef.current as HTMLCanvasElement).getBoundingClientRect();
    // Only a PEN reports pressure worth having. A mouse reports a constant 0.5
    // while down (and 0 in some browsers, which would collapse the stroke to
    // nothing), so it is pinned to the neutral middle and the line stays even.
    const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      pressure,
    ];
  };

  const onDown = (e: React.PointerEvent) => {
    if (!drawing) return;
    if (labelMode) {
      // An open input absorbs this click: commit if it has text, dismiss if
      // empty ("clicking elsewhere while empty dismisses") — and DON'T place
      // a new label from the same click. Otherwise, place the input here.
      if (pendingRef.current) {
        if (pendingRef.current.text.trim()) commitPendingLabel();
        else cancelPendingLabel();
        return;
      }
      const [x, y] = norm(e);
      setPendingLabel({ x, y, text: "" });
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    const at = norm(e);
    shapeStart.current = isShapeTool(tool) ? at : null;
    live.current = {
      color, size, pts: [at],
      opacity: toolOpacity(tool),
      widthScale: toolWidthScale(tool),
    };
    redraw();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawing || labelMode || !live.current) return;
    // EVERY point the OS actually sampled, not just the one it delivered.
    //
    // macOS coalesces pointermove events: move fast and a whole arc arrives as
    // a single event, so a quick stroke was built from a handful of samples.
    // perfect-freehand then outlines those few points as a polygon, and on a
    // wide stroke its straight segments are plainly visible — the faceted,
    // "pixelated" edge on exactly the strokes drawn fastest. getCoalescedEvents
    // hands back the samples the OS already took and threw away, so a fast arc
    // curves instead of turning into a run of flats.
    // A shape is a drag, not a trace: every move re-derives it from origin to
    // cursor, so it rubber-bands instead of accumulating a scribble.
    if (shapeStart.current) {
      live.current.pts = shapePoints(tool, shapeStart.current, norm(e));
      redraw();
      return;
    }
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    if (coalesced.length > 1) {
      const r = (canvasRef.current as HTMLCanvasElement).getBoundingClientRect();
      for (const c of coalesced) {
        const pressure = c.pointerType === "pen" && c.pressure > 0 ? c.pressure : 0.5;
        live.current.pts.push([
          Math.min(1, Math.max(0, (c.clientX - r.left) / r.width)),
          Math.min(1, Math.max(0, (c.clientY - r.top) / r.height)),
          pressure,
        ]);
      }
    } else {
      live.current.pts.push(norm(e));
    }
    redraw();
  };
  const onUp = () => {
    shapeStart.current = null;
    if (!drawing || !live.current) return;
    const finished = live.current;
    live.current = null;
    // Carry `labels` too — the labels ride the same payload as the strokes
    // (see the label-commit path above); dropping the field here would erase
    // every placed label on the next pen stroke.
    if (finished.pts.length > 0) onChange({ strokes: [...strokes, finished], labels });
  };

  // Leaving draw/label mode with an input still open → drop it (uncommitted).
  useEffect(() => {
    if (!drawing || !labelMode) cancelPendingLabel();
  }, [drawing, labelMode]);

  // Read-only with nothing to show (or fully faded) → render nothing.
  if (!drawing && (!annotationHasContent(annotation) || opacity <= 0)) return null;

  return (
    <div
      ref={wrapRef}
      className={"cp-annot" + (drawing ? " drawing" : "") + (drawing && labelMode ? " labeling" : "")}
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
      {/* Text labels — committed chips (draft + saved view) and, in label
          mode, the in-progress input at the clicked anchor. */}
      <AnnotationLabels labels={labels} color={labelColor} />
      {pendingLabel && (
        <LabelInput
          x={pendingLabel.x}
          y={pendingLabel.y}
          color={labelColor}
          value={pendingLabel.text}
          onChange={(text) => setPendingLabel((p) => (p ? { ...p, text } : p))}
          onCommit={commitPendingLabel}
          onCancel={cancelPendingLabel}
        />
      )}
      {drawing ? (
        <div className="cp-annot-tools">
          <div className="cp-annot-swatches">
            <ColorSwatches colors={PEN_COLORS} value={color} onPick={setColor} size={17} ariaLabel="Pen color" />
          </div>
          <span className="cp-annot-divider" />
          <div className="cp-annot-tools-row" role="radiogroup" aria-label="Drawing tool">
            {DRAW_TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={tool === t.id}
                className={"cp-annot-tool" + (tool === t.id ? " on" : "")}
                title={`${t.label}: ${t.hint}`}
                onClick={() => setTool(t.id)}
              >
                {t.label}
              </button>
            ))}
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
            onClick={() => { live.current = null; cancelPendingLabel(); onChange({ strokes: [] }); }}
            disabled={!annotationHasContent(annotation)}
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
