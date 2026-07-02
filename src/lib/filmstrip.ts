/**
 * Pure helpers for the timeline filmstrip scrubber.
 *
 * Kept dependency-free (no mediabunny import) so they unit-test in isolation.
 * The actual frame decode lives in `mediabunny-helpers.ts` (`extractFilmstrip`).
 */

/**
 * How many thumbnails to render across a scrub track `trackWidthPx` wide,
 * aiming for cells ~`targetCellPx` wide, clamped to `[min, max]`. Returns 0 for
 * a zero/unknown width (nothing to render yet).
 */
export function filmstripCount(
  trackWidthPx: number,
  targetCellPx = 72,
  min = 6,
  max = 24,
): number {
  if (!(trackWidthPx > 0)) return 0;
  const n = Math.round(trackWidthPx / Math.max(8, targetCellPx));
  return Math.max(min, Math.min(max, n));
}

/**
 * `count` sample timestamps (seconds) at the CENTRE of each equal time cell
 * across `[0, durationSec]`. Centre-sampling gives a representative frame per
 * cell rather than the frame sitting exactly on a cell boundary. Ascending, so
 * mediabunny's `canvasesAtTimestamps` takes its single-pass optimized path.
 */
export function filmstripTimestamps(durationSec: number, count: number): number[] {
  if (!(durationSec > 0) || count <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = (durationSec * (i + 0.5)) / count;
    out.push(Math.min(durationSec, Math.max(0, t)));
  }
  return out;
}
