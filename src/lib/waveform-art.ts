import type { WaveformPeaks } from "./waveform";

/**
 * Turn peak buckets into card-sized waveform art.
 *
 * WHY A CARD NEEDS ITS OWN REDUCTION. The timeline draws ~1500 buckets across
 * a window-wide track; a library card is roughly 200px of art. Handing the
 * full array to a 200px canvas means every pixel column aggregates seven or
 * eight buckets, and doing that aggregation per repaint — on a wall of forty
 * cards that re-render on every scan, hover and poster bump — is the kind of
 * cost that only shows up on somebody else's slower machine. Reducing ONCE to
 * the bar count the card actually draws makes the render a loop over ~48
 * numbers.
 *
 * SYMMETRIC BARS, NOT A MIN/MAX ENVELOPE. At card size the two halves of an
 * envelope are a few pixels each and read as noise. One magnitude per bar,
 * mirrored around the centre line, is the shape people recognise as "audio" at
 * a glance — which is the entire job here, since nobody edits from a
 * thumbnail.
 *
 * NORMALISED PER FILE. A quiet recording drawn at true amplitude is a flat
 * line, which looks like a broken thumbnail rather than a quiet take. Scaling
 * each file to its own loudest moment makes every card show its SHAPE. That is
 * the honest trade: the art tells you where the speech is, not how loud the
 * file is, and the loudness was never legible at 200px anyway.
 */

/** Magnitudes in [0, 1], one per bar, left to right. */
export function waveformBars(peaks: WaveformPeaks, barCount: number): number[] {
  const n = Math.max(1, Math.floor(barCount));
  const len = Math.min(peaks.mins.length, peaks.maxs.length);
  if (len === 0) return new Array(n).fill(0);

  const bars = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const from = Math.floor((i * len) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * len) / n));
    let peak = 0;
    for (let b = from; b < to && b < len; b += 1) {
      // The larger excursion either side of zero is this bucket's magnitude.
      const m = Math.max(Math.abs(peaks.mins[b]), Math.abs(peaks.maxs[b]));
      if (m > peak) peak = m;
    }
    bars[i] = peak;
  }

  // Normalise to the file's own loudest bar. A track that is silent all the
  // way through stays flat rather than dividing by zero into NaN.
  let loudest = 0;
  for (const v of bars) if (v > loudest) loudest = v;
  if (loudest <= 0) return bars;
  for (let i = 0; i < n; i += 1) bars[i] = bars[i] / loudest;
  return bars;
}

/**
 * An SVG path for the bars, as one filled shape.
 *
 * ONE PATH, NOT ONE RECT PER BAR. Forty cards times forty-eight bars is ~1900
 * DOM nodes for decoration; a single `<path>` is one. The shape is built as a
 * run of rounded-off columns mirrored about the vertical centre.
 *
 * `floor` gives every bar a visible stub, so a silent passage reads as a
 * quiet stretch of audio rather than a gap in the card.
 */
export function waveformPath(
  bars: readonly number[],
  width: number,
  height: number,
  opts?: { gap?: number; floor?: number },
): string {
  const n = bars.length;
  if (n === 0 || width <= 0 || height <= 0) return "";
  const gap = opts?.gap ?? 1;
  const floor = opts?.floor ?? 0.06;
  const mid = height / 2;
  const slot = width / n;
  // Never wider than its own slot, never thinner than a hairline. The floor
  // keeps a bar visible when hundreds are packed into a card; the ceiling
  // stops that floor from overhanging the box at the same density (the first
  // bar was landing at a negative x).
  const barW = Math.min(slot, Math.max(0.5, slot - gap));

  let d = "";
  for (let i = 0; i < n; i += 1) {
    const mag = Math.max(floor, Math.min(1, bars[i]));
    const h = (mag * height) / 2;
    const x = i * slot + (slot - barW) / 2;
    d += `M${round(x)} ${round(mid - h)}h${round(barW)}v${round(h * 2)}h${round(-barW)}z`;
  }
  return d;
}

/** Two decimals is well under a device pixel and keeps the path string short —
 *  the whole point of collapsing to one node. */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}
