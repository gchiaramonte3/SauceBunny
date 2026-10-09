import type { CSSProperties } from "react";

/** The most bars a strip draws; a longer cut is drawn in runs of bites. */
const BARS = 28;

/** Consecutive bites summed into at most `limit` runs, so a long cut keeps its shape. */
export function stripBars(frames: number[], limit = BARS): number[] {
  if (frames.length <= limit) return frames.map((length) => Math.max(1, length));
  const size = Math.ceil(frames.length / limit);
  const runs: number[] = [];
  for (let at = 0; at < frames.length; at += size) runs.push(Math.max(1, frames.slice(at, at + size).reduce((sum, length) => sum + length, 0)));
  return runs;
}

/**
 * A string out drawn as a thumbnail: its bites in record order, each as wide
 * as it plays. It replaces an icon every row shared, which said nothing; this
 * says at a glance whether a cut is one long take or thirty quick ones, and
 * an empty one reads as empty.
 */
export function EditStrip({ frames, bites }: { frames: number[]; bites: number }) {
  if (!bites) return <span className="cp-te-shelf-cut is-empty" aria-hidden="true" />;
  return <span className="cp-te-shelf-cut" aria-hidden="true">
    {stripBars(frames).map((length, index) => <span key={index} style={{ "--te-bite": length } as CSSProperties} />)}
  </span>;
}
