type Props = {
  /** In and Out edges in the ruler's own units; null when not set. */
  from: number | null | undefined; to: number | null | undefined;
  x: (at: number) => string; w: (length: number) => string;
  /** An extra class on the closed range, for a view's own hooks. */
  rangeClass?: string;
  /** Clears both marks: a × at the end of a closed range, so clearing can be seen and clicked, not only typed (G). */
  onClear?: () => void;
};

/**
 * In and Out on a ruler: the one mark the app draws (marks.css), a stem with
 * a wing pointing away from the marked span, like IconMarkIn/IconMarkOut and
 * Clip's track. A closed range when both are set and Out follows In, else
 * whichever of the two is set. AAF Audio and String Outs both draw it here,
 * and both put a Clear × on a closed range.
 */
export function RulerMarks({ from, to, x, w, rangeClass, onClear }: Props) {
  if (from != null && to != null && to > from) {
    return <>
      <span className={rangeClass ? `cp-mark-range ${rangeClass}` : "cp-mark-range"} style={{ left: x(from), width: w(to - from) }} aria-hidden="true" />
      {/* On the ruler, a press scrubs: the × keeps its press to itself. */}
      {onClear && <button type="button" className="cp-mark-clear" style={{ left: `calc(${x(to)} - 26px)` }} aria-label="Clear marks" title="Clear marks (G)"
        onPointerDown={(event) => event.stopPropagation()} onClick={onClear}>×</button>}
    </>;
  }
  return <>{from != null && <span className="cp-mark in" style={{ left: x(from) }} aria-hidden="true" />}
    {to != null && <span className="cp-mark out" style={{ left: x(to) }} aria-hidden="true" />}</>;
}
