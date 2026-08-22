import { useEffect, useMemo, useState } from "react";
import { CHAPTERS_CHANGED_EVENT, loadChapters } from "../lib/chapters";
import { REVIEW_CHANGED_EVENT, commentMarkers, loadReview } from "../lib/review";

/**
 * The marker data the reader's compact player draws on its position bar.
 *
 * The reader can be reading a transcript for a source that is NOT the one open
 * in Clip, so this cannot just read the Clip transport's state. Getting that
 * wrong shows one clip's in/out marks on another clip's bar, which is the same
 * drift as queued marks bleeding onto the loaded source's timeline: the marker
 * is real, it is just about something else.
 *
 * So the rule is per-field, not per-panel:
 *   chapters / comments  keyed by the READER's own source, so they show
 *                        whatever transcript you opened;
 *   in / out             only when the reader is looking at the very source
 *                        Clip has loaded, because marks live in the transport's
 *                        state and belong to that one source.
 */
export type ReaderMarkers = {
  markIn: number | null;
  markOut: number | null;
  chapters: { time: number; title: string }[];
  comments: { time: number; resolved: boolean }[];
};

const EMPTY: ReaderMarkers = { markIn: null, markOut: null, chapters: [], comments: [] };

export function useReaderMarkers(args: {
  /** The original path of the source the reader is playing, or null. */
  readerPath: string | null;
  /** The path Clip currently has loaded (null when it holds a web source). */
  clipPath: string | null;
  /** Clip's review/chapters key — fingerprint-resolved, so it survives moves. */
  clipSourceKey: string | null;
  inFrames: number | null;
  outFrames: number | null;
  fps: number;
}): ReaderMarkers {
  const { readerPath, clipPath, clipSourceKey, inFrames, outFrames, fps } = args;
  const sameAsClip = readerPath != null && readerPath === clipPath;
  // Prefer Clip's resolved key when it IS this source: it may have been
  // fingerprint-resolved to a doc written under an older path, and the raw
  // path would miss those notes.
  const key = readerPath == null ? null : (sameAsClip && clipSourceKey) || readerPath;

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener(CHAPTERS_CHANGED_EVENT, bump);
    window.addEventListener(REVIEW_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener(CHAPTERS_CHANGED_EVENT, bump);
      window.removeEventListener(REVIEW_CHANGED_EVENT, bump);
    };
  }, []);

  return useMemo(() => {
    if (!key) return EMPTY;
    const doc = loadReview(key);
    return {
      // fps can arrive as 0 before the source is probed; dividing by it gives
      // Infinity, which stageMarkers then drops - but null is the honest
      // "not known yet" and keeps the pin from flickering in at 0.
      markIn: sameAsClip && inFrames != null && fps > 0 ? inFrames / fps : null,
      markOut: sameAsClip && outFrames != null && fps > 0 ? outFrames / fps : null,
      chapters: loadChapters(key).map((c) => ({ time: c.time, title: c.title })),
      comments: commentMarkers(doc, doc.activeVersionId).map((m) => ({
        time: m.time, resolved: m.resolved,
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` is the re-read signal
  }, [key, sameAsClip, inFrames, outFrames, fps, tick]);
}
