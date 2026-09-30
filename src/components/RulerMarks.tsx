type Props = {
  /** In and Out edges in the ruler's own units; null when not set. */
  from: number | null | undefined; to: number | null | undefined;
  x: (at: number) => string; w: (length: number) => string;
  /** An extra class on the closed range, for a view's own hooks. */
  rangeClass?: string;
};

/**
 * In and Out on a ruler: the one mark the app draws (marks.css), a stem with
 * a wing pointing away from the marked span, like IconMarkIn/IconMarkOut and
 * Clip's track. A closed range when both are set and Out follows In, else
 * whichever of the two is set. AAF Audio and String Outs both draw it here.
 */
export function RulerMarks({ from, to, x, w, rangeClass }: Props) {
  if (from != null && to != null && to > from) {
    return <span className={rangeClass ? `cp-mark-range ${rangeClass}` : "cp-mark-range"} style={{ left: x(from), width: w(to - from) }} aria-hidden="true" />;
  }
  return <>{from != null && <span className="cp-mark in" style={{ left: x(from) }} aria-hidden="true" />}
    {to != null && <span className="cp-mark out" style={{ left: x(to) }} aria-hidden="true" />}</>;
}
