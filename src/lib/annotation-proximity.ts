/**
 * Which saved drawings show as the playhead passes them.
 *
 * The monitor used to keep the single NEAREST drawing, so two people
 * annotating the same moment meant one of them was silently invisible - and
 * the tie was broken by whichever came first in the document. On a shared
 * review that is wrong twice over: the second note is the one you have not
 * seen yet, and nothing on screen said it was there.
 *
 * Pure and here rather than in the component because "which of these is on
 * screen, and how solid is each" is a rule worth pinning, and a component
 * that owns it cannot be tested without a canvas and a playhead store.
 */

export type ProximityInput = {
  /** Seconds into the source. */
  time: number;
  /** The reviewer's colour, when the note has one. */
  color?: string;
};

export type ProximityPick<T extends ProximityInput> = T & {
  /** Distance from the playhead, in seconds. */
  dist: number;
  /** 1 at the exact frame, falling to 0 at the edge of the window. */
  opacity: number;
};

/**
 * Everything within `window` seconds of `playheadSec`, furthest first.
 *
 * Furthest first so the caller can paint in order and have the NEAREST note
 * land on top. Ties break on time and then colour rather than on input
 * order, because input order is document order and can change underneath a
 * render - which would make two overlapping notes swap depth as you scrub.
 *
 * `cap` bounds the work: this is read at up to 60Hz and each pick costs a
 * canvas. Four overlapping notes on one frame is already a busy frame.
 */
export function annotationsNear<T extends ProximityInput>(
  annotations: readonly T[],
  playheadSec: number,
  window: number,
  cap = 4,
): ProximityPick<T>[] {
  if (window <= 0) return [];
  return annotations
    .map((a) => {
      const dist = Math.abs(a.time - playheadSec);
      return { ...a, dist, opacity: Math.max(0, 1 - dist / window) };
    })
    .filter((a) => a.dist <= window && a.opacity > 0)
    .sort((x, y) => y.dist - x.dist || x.time - y.time
      || (x.color ?? "").localeCompare(y.color ?? ""))
    // From the END, so the ones actually kept are the nearest.
    .slice(-Math.max(0, cap));
}

/**
 * Has the playhead travelled far enough to let a PINNED drawing go?
 *
 * Clicking a comment seeks to its time and pins its drawing, which is right:
 * you asked to look at it and it must not dissolve while you study the frame.
 * But the pin had no release, so from then on the drawing was painted over
 * every frame in the source - reported as "the drawing is persistent across
 * all frames".
 *
 * Deliberately WIDER than the proximity fade. Those are two different
 * questions: the fade asks "is a drawing near enough to glimpse", and this
 * asks "have you left the thing you opened". Nudging a frame or two while
 * studying a note must not throw it away.
 *
 * A pin with no time (nothing to be away FROM) never releases on its own.
 */
export function shouldReleasePin(
  playheadSec: number,
  pinnedAt: number | null | undefined,
  releaseAfter: number,
): boolean {
  if (pinnedAt == null || !Number.isFinite(pinnedAt)) return false;
  if (!Number.isFinite(playheadSec)) return false;
  return Math.abs(playheadSec - pinnedAt) > releaseAfter;
}
