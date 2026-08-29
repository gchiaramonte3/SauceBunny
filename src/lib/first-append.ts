/**
 * What to do on a rebuilt pipeline's first data-bearing append.
 *
 * Two things want to set `currentTime` at that moment and they had no agreed
 * order, which produced two separate high-severity bugs within an hour of the
 * paint nudge being written:
 *
 *   - the LANDING seek, which puts a rebuilt stream exactly on the second the
 *     user clicked rather than on the preceding keyframe; and
 *   - the PAINT NUDGE, which exists only because WKWebView presents nothing
 *     when a fresh MediaSource is attached while paused. Playing hides this,
 *     because play() forces the decode.
 *
 * The bugs, both of which this function's tests now pin:
 *
 *   1. The nudge guarded on "no landing target outstanding", but the rebuild
 *      timer arms that target for BOTH timeline modes while only ABSOLUTE mode
 *      ever consumed it. In rebased mode (HLS, and any source whose epoch probe
 *      fails) the target stayed armed forever, so the nudge never ran on the
 *      very path it was written for - and it burned its one-shot before the
 *      guard, so no later append retried.
 *   2. In absolute mode - which is the NORMAL web case, not the exotic one -
 *      the landing seek fires and clears the target, and the nudge then saw a
 *      null target and immediately overwrote the seek with the buffer's origin.
 *      A paused click at 2666.0s landed at 2661.0s, a whole GOP early.
 *
 * The rule this encodes: a landing seek IS a paint, so the nudge is what
 * happens when nothing else set the clock. And the one-shot is only spent when
 * something actually happened, so a still-unreachable landing target leaves the
 * next append free to try again.
 */

export type FirstAppendPlan = {
  /** Seek here to satisfy the landing target, or null. */
  landTo: number | null;
  /** Seek here purely to force a frame to present, or null. */
  nudgeTo: number | null;
  /** Clear the pending landing target. */
  clearLand: boolean;
  /** Consume the once-per-pipeline paint attempt. */
  burnOneShot: boolean;
};

const NONE: FirstAppendPlan = { landTo: null, nudgeTo: null, clearLand: false, burnOneShot: false };

export function planFirstAppend(s: {
  /** Has this pipeline already had its paint attempt? */
  painted: boolean;
  /** Absolute timeline (currentTime IS source time) vs rebased. */
  absolute: boolean;
  /** Source-time second the user asked for, or null. */
  pendingLand: number | null;
  /** buffered.start(0) — the fMP4's start PTS. */
  bufferedStart: number;
  /** buffered.end(last). */
  bufferedEnd: number;
  /** The element's current time. */
  currentTime: number;
  paused: boolean;
  /** False when there is no buffered range yet. */
  hasBuffer: boolean;
}): FirstAppendPlan {
  if (!s.hasBuffer) return NONE;

  // ── The landing target ────────────────────────────────────────────────
  // Armed for both modes by the rebuild timer. Only absolute mode has a seek
  // to perform: in rebased mode the pipeline was rebuilt starting AT the
  // requested second, so the target is already satisfied by the stream
  // existing. Leaving it armed there is what blocked the nudge forever.
  let landTo: number | null = null;
  let clearLand = false;
  if (s.pendingLand != null) {
    if (!s.absolute) {
      clearLand = true;
    } else if (s.bufferedEnd >= s.pendingLand) {
      clearLand = true;
      landTo = s.pendingLand;
    }
    // else: absolute, buffer has not reached it yet — keep waiting.
  }

  if (s.painted) return { landTo, nudgeTo: null, clearLand, burnOneShot: false };

  // A landing seek is itself a paint; nudging after it would drag the playhead
  // back to the buffer origin, a whole GOP before where the user clicked.
  if (landTo != null) return { landTo, nudgeTo: null, clearLand, burnOneShot: true };

  // Still waiting on a reachable landing target: do not spend the one-shot,
  // or a later append can never paint.
  if (s.pendingLand != null && !clearLand) return { landTo: null, nudgeTo: null, clearLand: false, burnOneShot: false };

  // Playing needs no nudge — play() forces the decode.
  if (!s.paused) return { landTo, nudgeTo: null, clearLand, burnOneShot: false };

  // Nudge onto the buffer's own origin, which is exactly where the playhead
  // already reports (clockOrigin is subtracted back out), so this moves the
  // picture and not the clock. An assignment equal to the current time is not
  // a seek and decodes nothing, so step a millisecond — far under a frame, and
  // it guarantees the `seeked` that also retires the scrub-preview overlay.
  const to = Math.abs(s.currentTime - s.bufferedStart) < 1e-3 ? s.bufferedStart + 1e-3 : s.bufferedStart;
  return { landTo: null, nudgeTo: to, clearLand, burnOneShot: true };
}
