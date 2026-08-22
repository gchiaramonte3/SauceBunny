/**
 * What the reader's compact player draws on its position bar.
 *
 * The panel is a follow-along viewport, not the NLE, so it does not get a
 * timeline. It does get the DATA a timeline carries: where the in/out marks
 * are, where the chapters fall, where somebody left a comment. Reading a
 * transcript and wanting to know "is this the bit I marked" without going back
 * to Clip is the whole reason the panel exists.
 *
 * Pure, and separate from the component, for the reason this bit is easy to
 * get wrong: it is arithmetic against a duration that arrives late and marks
 * that may belong to a different source. Both of those produce pins in the
 * wrong place rather than an error, which is the kind of bug you only catch by
 * pinning the numbers.
 */

export type StageMarkerKind = "in" | "out" | "chapter" | "comment";

export type StageMarker = {
  kind: StageMarkerKind;
  /** Absolute source seconds. */
  time: number;
  /** Position along the bar, 0..100. */
  pct: number;
  label: string;
  /** How many markers this pin stands for once overlapping ones merged. */
  count: number;
};

export type StageMarkerInput = {
  duration: number;
  markIn: number | null;
  markOut: number | null;
  chapters: readonly { time: number; title: string }[];
  comments: readonly { time: number; resolved: boolean }[];
  /** Show comments that have been resolved. Off: they are done being looked at. */
  showResolved?: boolean;
};

/**
 * Pins closer together than this share one dot.
 *
 * The bar is around 280px wide docked. Two chapters 4 seconds apart in a
 * two-hour recording are 0.05% apart, i.e. the same pixel, and drawing both
 * puts a darker smudge there and a tooltip you cannot aim at. One pin that
 * says "3" is the honest rendering of what fits.
 */
const MERGE_PCT = 1.2;

function clampPct(time: number, duration: number): number {
  return Math.max(0, Math.min(100, (time / duration) * 100));
}

/** Merge same-kind pins that would land on the same pixel, keeping the first. */
function merge(pins: StageMarker[]): StageMarker[] {
  const out: StageMarker[] = [];
  for (const p of [...pins].sort((a, b) => a.time - b.time)) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === p.kind && p.pct - prev.pct < MERGE_PCT) {
      prev.count += p.count;
      continue;
    }
    out.push({ ...p });
  }
  return out;
}

/**
 * The pins and the in/out band for one source.
 *
 * Times outside the source are DROPPED rather than clamped to an end. A mark
 * belonging to a different clip would otherwise pile up on the last pixel and
 * read as a real marker at the end of this one - the same drift as marks from
 * a queued source bleeding onto the timeline of the loaded one.
 */
export function stageMarkers(i: StageMarkerInput): {
  pins: StageMarker[];
  band: { startPct: number; widthPct: number } | null;
} {
  // Nothing can be positioned before the duration is known, and a zero
  // duration would divide by zero into NaN offsets.
  if (!(i.duration > 0) || !Number.isFinite(i.duration)) return { pins: [], band: null };
  const inRange = (t: number) => Number.isFinite(t) && t >= 0 && t <= i.duration;

  const pins: StageMarker[] = [];
  if (i.markIn != null && inRange(i.markIn)) {
    pins.push({ kind: "in", time: i.markIn, pct: clampPct(i.markIn, i.duration), label: "In", count: 1 });
  }
  if (i.markOut != null && inRange(i.markOut)) {
    pins.push({ kind: "out", time: i.markOut, pct: clampPct(i.markOut, i.duration), label: "Out", count: 1 });
  }
  for (const c of i.chapters) {
    if (!inRange(c.time)) continue;
    pins.push({ kind: "chapter", time: c.time, pct: clampPct(c.time, i.duration), label: c.title, count: 1 });
  }
  for (const c of i.comments) {
    if (!inRange(c.time)) continue;
    if (c.resolved && !i.showResolved) continue;
    pins.push({ kind: "comment", time: c.time, pct: clampPct(c.time, i.duration), label: "Comment", count: 1 });
  }

  // The band needs BOTH ends to mean anything. One mark on its own is a point
  // in the recording, and shading from it to the end would claim a range
  // nobody set.
  const bandStart = i.markIn != null && inRange(i.markIn) ? i.markIn : null;
  const bandEnd = i.markOut != null && inRange(i.markOut) ? i.markOut : null;
  const band =
    bandStart != null && bandEnd != null && bandEnd > bandStart
      ? {
          startPct: clampPct(bandStart, i.duration),
          widthPct: clampPct(bandEnd, i.duration) - clampPct(bandStart, i.duration),
        }
      : null;

  return { pins: merge(pins), band };
}

/** One line for the panel: what the bar is showing, in words. */
export function markerSummary(pins: readonly StageMarker[]): string {
  const n = (k: StageMarkerKind) => pins.filter((p) => p.kind === k).reduce((s, p) => s + p.count, 0);
  const parts: string[] = [];
  const chapters = n("chapter");
  const comments = n("comment");
  if (n("in") || n("out")) parts.push("in/out");
  if (chapters) parts.push(`${chapters} chapter${chapters === 1 ? "" : "s"}`);
  if (comments) parts.push(`${comments} comment${comments === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
