import { useRef } from "react";

type Props = {
  /** "column" sits between two side-by-side panes; "row" between stacked ones. */
  between: "column" | "row";
  label: string; value: number; min: number; max: number;
  /** True when dragging toward the start (left or up) makes the pane bigger. */
  invert?: boolean;
  onChange: (value: number) => void; onReset: () => void;
};

/**
 * A pane divider: a 1px hairline with a wider grab area. Drag it, or focus it
 * and use the arrow keys (Shift for bigger steps, Home and End for the limits).
 * Double-click puts the pane back at its usual size. The same three behaviours
 * as an NSSplitView divider, so the SwiftUI port inherits them for free.
 */
export function TeSplitter({ between, label, value, min, max, invert, onChange, onReset }: Props) {
  const drag = useRef<{ from: number; value: number } | null>(null);
  const axis = (event: React.PointerEvent) => between === "column" ? event.clientX : event.clientY;
  const sign = invert ? -1 : 1;
  const set = (next: number) => onChange(Math.max(min, Math.min(max, Math.round(next))));
  return <div className={`cp-te-split is-${between}`} role="separator" tabIndex={0}
    aria-orientation={between === "column" ? "vertical" : "horizontal"} aria-label={label}
    aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max}
    title={`${label}. Drag, or use the arrow keys. Double-click to reset.`}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { from: axis(event), value };
    }}
    onPointerMove={(event) => { if (drag.current) set(drag.current.value + sign * (axis(event) - drag.current.from)); }}
    onPointerUp={() => { drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onDoubleClick={onReset}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 32 : 8;
      const grow = between === "column" ? (invert ? "ArrowLeft" : "ArrowRight") : (invert ? "ArrowUp" : "ArrowDown");
      const shrink = between === "column" ? (invert ? "ArrowRight" : "ArrowLeft") : (invert ? "ArrowDown" : "ArrowUp");
      const next = event.key === grow ? value + step : event.key === shrink ? value - step
        : event.key === "Home" ? min : event.key === "End" ? max : null;
      if (next == null) return;
      event.preventDefault();
      set(next);
    }} />;
}
