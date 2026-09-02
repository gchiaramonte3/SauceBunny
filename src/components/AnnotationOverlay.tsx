import { ColorSwatches } from "./ColorSwatches";
import { useEffect, useRef, useState } from "react";
import {
  DRAW_TOOLS, isShapeTool, shapePoints, toolOpacity, toolWidthScale, type DrawTool,
} from "../lib/draw-tools";
import { annotationHasContent, type AnnotationStrokes } from "../lib/review";
import { paintStroke } from "../lib/draw-paint";
import {
  IconPencil, IconToolArrow, IconToolEllipse, IconToolHighlighter, IconToolRect,
} from "./Icons";
import { useDismiss } from "../hooks/use-dismiss";
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



/** Glyph per tool - label and hint stay as the tooltip and accessible name. */
const TOOL_ICON: Record<DrawTool, (p: { size?: number }) => JSX.Element> = {
  pen: IconPencil,
  highlighter: IconToolHighlighter,
  arrow: IconToolArrow,
  rect: IconToolRect,
  ellipse: IconToolEllipse,
};

export function AnnotationOverlay({
  annotation, drawing, opacity = 1, onChange, onDismiss, labelMode = false, labelColor = "#4dabf7",
  onStroke,
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
  /** LIVE mode. Fired once per finished stroke INSTEAD of `onChange`, so the
   *  stroke can be relayed and forgotten rather than accumulated into a draft
   *  annotation. Set by live telestration, which must never write a note. */
  onStroke?: (stroke: AnnotationStrokes["strokes"][number]) => void;
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
  // The palette lives in a popover under a single current-colour well. Eleven
  // wells inline were ~275px of a panel that could only afford ~500, which is
  // what crushed them into a one-per-row column and blew the toolbar up to a
  // third of the picture.
  const [colorOpen, setColorOpen] = useState(false);
  const colorWellRef = useRef<HTMLDivElement>(null);
  useDismiss(colorWellRef, () => setColorOpen(false), colorOpen);
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

  // The sizing effect below re-arms on visibility, not on every render, so
  // its ResizeObserver would otherwise repaint through the redraw closure
  // captured at arm time - a mid-draft window resize would erase every
  // stroke drawn since. The ref always points at this render's redraw.
  const redrawRef = useRef<() => void>(() => {});
  const redraw = () => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const w = cv.width, h = cv.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);
    // The painter itself lives in lib/draw-paint so the live telestration
    // layer paints identical strokes instead of owning a second copy.
    const paint = (s: Stroke) => paintStroke(ctx, s, w, h, dpr, { inProgress: s === live.current });
    strokes.forEach(paint);
    if (live.current) paint(live.current);
  };
  redrawRef.current = redraw;

  // Whether anything renders at all - the early return below uses this, and
  // so does the sizing effect's dependency list. A BOOLEAN, deliberately:
  // depping on raw `opacity` would tear down and re-arm the ResizeObserver
  // on every proximity-fade tick, up to 60 times a second during playback.
  const visible = drawing || (annotationHasContent(annotation) && opacity > 0);

  // Keep the backing store sized to the displayed canvas (DPR-aware) + redraw.
  //
  // Re-armed on `visible`, and that dependency IS the feature. With deps []
  // this ran exactly once, on an instance whose first render had returned
  // null - both refs were empty, the guard bailed, and nothing ever sized
  // the canvas. When the user then clicked Draw, the canvas mounted with no
  // width/height attributes: the HTML default 300x150 backing store,
  // stretched by CSS across the whole monitor. On a retina display that is
  // an ~8x upscale, which is the "pixelated and big even at the smallest
  // level" every first-time drawing session saw. The DPR math below was
  // correct the whole time; it just never executed on the first-use path -
  // the component test always rendered with drawing already true, which is
  // exactly how the path went untested.
  useEffect(() => {
    if (!visible) return;
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
      cv.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
      redrawRef.current();
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
  }, [visible]);

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
      const to = norm(e);
      live.current.pts = shapePoints(tool, shapeStart.current, to);
      // The anchors, so the renderer can draw real geometry. `pts` stays
      // beside them for peers that predate this field.
      live.current.shape = {
        kind: tool as "arrow" | "rect" | "ellipse",
        from: [shapeStart.current[0], shapeStart.current[1]],
        to: [to[0], to[1]],
      };
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
    if (finished.pts.length === 0) return;
    // LIVE mode never accumulates. Handing the stroke straight out is what
    // keeps telestration off the review doc: there is no draft to post.
    if (onStroke) { onStroke(finished); return; }
    onChange({ strokes: [...strokes, finished], labels });
  };

  // Leaving draw/label mode with an input still open → drop it (uncommitted).
  useEffect(() => {
    if (!drawing || !labelMode) cancelPendingLabel();
  }, [drawing, labelMode]);

  // Read-only with nothing to show (or fully faded) → render nothing.
  if (!visible) return null;

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
          <div className="cp-annot-colorwell" ref={colorWellRef}>
            <button
              type="button"
              className="cp-annot-colorbtn"
              aria-label="Pen color"
              aria-expanded={colorOpen}
              title="Pen color"
              onClick={() => setColorOpen((v) => !v)}
            >
              <span className="cp-annot-colorchip" style={{ background: color }} />
            </button>
            {colorOpen && (
              <div className="cp-annot-color-popover" role="group" aria-label="Pen color">
                <ColorSwatches
                  colors={PEN_COLORS}
                  value={color}
                  onPick={(c) => { setColor(c); setColorOpen(false); }}
                  size={17}
                  ariaLabel="Pen color"
                />
              </div>
            )}
          </div>
          <span className="cp-annot-divider" />
          <div className="cp-annot-tools-row" role="radiogroup" aria-label="Drawing tool">
            {DRAW_TOOLS.map((t) => {
              const Glyph = TOOL_ICON[t.id];
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={tool === t.id}
                  aria-label={t.label}
                  className={"cp-annot-tool" + (tool === t.id ? " on" : "")}
                  title={`${t.label}: ${t.hint}`}
                  onClick={() => setTool(t.id)}
                >
                  <Glyph size={15} />
                </button>
              );
            })}
          </div>
          <span className="cp-annot-divider" />
          {/* The preview shows the EFFECTIVE stroke: the active tool's width
              multiplier and opacity applied to the slider value, in the pen
              colour. "Smallest slider position, unclear on which tool" was
              the exact complaint - a dot that ignored the highlighter's 3x
              was answering a different question than the one the slider
              asks. The numeral is the slider value itself. */}
          <div
            className="cp-annot-sizectl"
            title={`Brush size: ${size}${tool === "highlighter" ? " (highlighter draws 3x wide)" : ""}`}
          >
            <span className="cp-annot-previewbox" aria-hidden="true">
              <span
                className="cp-annot-dot"
                style={{
                  width: Math.min(22, Math.max(2, size * toolWidthScale(tool) * 0.5)),
                  height: Math.min(22, Math.max(2, size * toolWidthScale(tool) * 0.5)),
                  background: color,
                  opacity: toolOpacity(tool),
                }}
              />
            </span>
            <input
              type="range" min={MIN_SIZE} max={MAX_SIZE} step={1} value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              aria-label="Brush size"
            />
            <span className="cp-annot-sizenum">{size}</span>
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
