/**
 * Seek-target math — THE single place that clamps a user seek against the
 * source duration.
 *
 * THE INVARIANT (root cause RC1 of the recurring "playhead snaps backward"
 * regression — see _design/seek-regression-diagnosis.md): an UNKNOWN duration
 * must NEVER clamp a seek. durationFrames derives solely from yt-dlp
 * metadata; on long sources it is 0 during the playback-first window, stays 0
 * forever if fetch_metadata fails, and can be UNDERSTATED when yt-dlp
 * misreports. Clamping against those values sent every click to frame 0 (or
 * dragged far clicks back to the false end, e.g. 19:02 → 14:53). The player
 * keeps its own authoritative-duration guard below this layer, so forwarding
 * the raw target is always safe.
 *
 * Every App-level seek path (timeline click, transcript cue, panel bus,
 * frame step, seconds jump, marks) must route through these functions
 * instead of re-deriving `durationFrames - 1` inline — the copy-pasted inline
 * clamps are exactly how this bug kept coming back.
 */

/** Clamp a frame target for a seek. Unknown duration (<= 0) passes the target
 *  through untouched (floored, non-negative) — never to frame 0. */
export function clampSeekFrames(frames: number, durationFrames: number): number {
  const f = Number.isFinite(frames) ? Math.max(0, Math.floor(frames)) : 0;
  if (durationFrames <= 0) return f;
  return Math.min(durationFrames - 1, f);
}

/** Upper bound for seconds-domain seeks. Infinity when the duration is
 *  unknown, so `Math.min(max, target)` never drags a target backward. */
export function maxSeekSeconds(durationFrames: number, fps: number): number {
  if (durationFrames <= 0) return Infinity;
  return (durationFrames - 1) / Math.max(1, Math.round(fps));
}
