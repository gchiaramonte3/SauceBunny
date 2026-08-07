/**
 * The mark-in / mark-out machine for a ranged review comment.
 *
 * WHY THIS IS ITS OWN FILE. It is a four-state machine — IDLE, IN-ARMED,
 * OUT-ARMED, SET — crossed with three actions and a minimum-span rule, so
 * roughly a dozen transitions, several of which deliberately do nothing. It
 * lived inside ReviewPanel as three closures over `useState` setters, which
 * made every one of those transitions unreachable from a test: you cannot ask
 * a component "what does OUT-ARMED do when I mark IN a hair before the OUT
 * mark" without mounting it and driving a playhead. The answer matters (it
 * refuses, and stays armed), and nothing was checking it.
 *
 * PURE, AND RETURNS THE WHOLE RANGE. Each function takes the current range and
 * a time and returns the next range. Returning the same object identity is how
 * a refusal is expressed, so a caller can cheaply tell "nothing happened" from
 * "moved". The component keeps the parts that are genuinely its own: reading
 * the playhead, and refusing to mark at all before the reviewer is named.
 *
 * WHY A MINIMUM SPAN AT ALL. A range whose ends are the same frame is a point
 * comment wearing a range's clothes: it draws a zero-width band, it exports as
 * a degenerate marker, and the user meant to tap. Below the threshold the
 * machine either refuses (while completing) or collapses back to a single
 * armed mark (while adjusting a set range) — never silently produces one.
 */

/** Seconds. Below this an "span" is really a point, and is treated as one. */
export const MIN_RANGE_SPAN = 0.05;

/**
 * Is the distance between two marks a real span, or a point?
 *
 * Exported because the PREVIEW has to answer it the same way the POST does.
 * They disagreed: the timeline's live band clamped against the anchor but had
 * no minimum, so scrubbing to within a frame or two of an armed mark drew a
 * band (a visible one — the band has a minimum rendered width) while the
 * comment that actually landed was a point. The preview showed a range the
 * user was never going to get.
 */
export function isRealSpan(a: number, b: number): boolean {
  return Math.abs(b - a) >= MIN_RANGE_SPAN;
}

/** Both null = IDLE. One set = ARMED. Both set = SET. */
export type MarkRange = {
  in: number | null;
  out: number | null;
};

export const EMPTY_RANGE: MarkRange = { in: null, out: null };

/** Mark IN at `t`. */
export function markRangeIn(cur: MarkRange, t: number): MarkRange {
  // IDLE or IN-ARMED: (re)arm IN. There is no OUT to complete against.
  if (cur.out == null) return { in: t, out: null };

  // OUT-ARMED: complete the span, in whichever order the marks were made.
  if (cur.in == null) {
    const a = Math.min(t, cur.out);
    const b = Math.max(t, cur.out);
    // Too short to be a span — refuse and stay armed rather than make a
    // zero-width range the user did not ask for.
    if (b - a < MIN_RANGE_SPAN) return cur;
    return { in: a, out: b };
  }

  // SET: marking IN at or past the OUT would invert the range, so the range
  // collapses to a fresh armed IN instead of flipping under the user.
  if (cur.out - t < MIN_RANGE_SPAN) return { in: t, out: null };

  // SET: ordinary move of the IN edge.
  return { in: t, out: cur.out };
}

/** Mark OUT at `t`. The mirror of markRangeIn. */
export function markRangeOut(cur: MarkRange, t: number): MarkRange {
  if (cur.in == null) return { in: null, out: t };

  if (cur.out == null) {
    const a = Math.min(cur.in, t);
    const b = Math.max(cur.in, t);
    if (b - a < MIN_RANGE_SPAN) return cur;
    return { in: a, out: b };
  }

  if (t - cur.in < MIN_RANGE_SPAN) return { in: null, out: t };

  return { in: cur.in, out: t };
}

/**
 * The composer button's single-button cycle: arm IN, complete, re-arm.
 *
 * Distinct from pressing the IN key twice, which re-arms IN in place. The
 * button has to walk the whole cycle because it is the only affordance a
 * mouse user has.
 */
export function tapRange(cur: MarkRange, t: number): MarkRange {
  if (cur.in != null && cur.out != null) return { in: t, out: null }; // SET → re-arm
  if (cur.in != null) return markRangeOut(cur, t);                    // IN-ARMED → complete
  return markRangeIn(cur, t);                                         // IDLE / OUT-ARMED
}

/**
 * What times a comment posted right now would carry.
 *
 * An ARMED range still posts: the pill has been showing a live span against
 * the playhead, and the user pressing post means that span. The live edge is
 * CLAMPED against the fixed mark — scrubbing behind an armed IN cannot produce
 * an inverted range, it degrades to a point comment at the mark. That clamp
 * has to match what the preview band draws, or the comment lands somewhere the
 * user was not shown.
 */
export function rangeToPost(
  cur: MarkRange, playheadSec: number,
): { timeStart: number; timeEnd: number | null } {
  if (cur.in != null && cur.out != null) {
    return { timeStart: cur.in, timeEnd: cur.out };
  }
  if (cur.in != null) {
    const end = Math.max(playheadSec, cur.in);
    return end - cur.in >= MIN_RANGE_SPAN
      ? { timeStart: cur.in, timeEnd: end }
      : { timeStart: cur.in, timeEnd: null };
  }
  if (cur.out != null) {
    const start = Math.min(playheadSec, cur.out);
    return cur.out - start >= MIN_RANGE_SPAN
      ? { timeStart: start, timeEnd: cur.out }
      : { timeStart: cur.out, timeEnd: null };
  }
  return { timeStart: playheadSec, timeEnd: null };
}
