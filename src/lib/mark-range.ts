/**
 * Turning a span of transcript seconds into transport frames.
 *
 * Pulled out of App because it is the one seam between the app's two clocks —
 * the transcript speaks seconds, the transport speaks frames — and every way
 * it can be wrong is silent: an off-by-one lands the out point on the wrong
 * frame, an unclamped value marks past the end of the source, and an inverted
 * range produces an export that fails much later with no obvious cause.
 */

export type MarkRange = { inFrames: number; outFrames: number };

/**
 * @param durationFrames 0 or less means "unknown", which must NOT clamp to
 *   zero — an unknown duration is the state a source is in while it loads, and
 *   clamping there would silently mark frame 0 to frame 0.
 * @returns null when the range is not a clip: zero-length, inverted, or
 *   entirely past the end. The caller leaves the existing marks alone rather
 *   than setting something the export would refuse.
 */
export function markRangeFromSeconds(
  startSeconds: number,
  endSeconds: number,
  fps: number,
  durationFrames: number,
): MarkRange | null {
  if (!(fps > 0) || !Number.isFinite(fps)) return null;
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return null;
  const toFrames = (sec: number) => Math.max(0, Math.round(sec * fps));
  const max = durationFrames > 0 ? durationFrames - 1 : Number.POSITIVE_INFINITY;
  const inF = Math.min(toFrames(startSeconds), max);
  const outF = Math.min(toFrames(endSeconds), max);
  if (outF <= inF) return null;
  return { inFrames: inF, outFrames: outF };
}
