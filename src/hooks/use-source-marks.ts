import { useEffect, useRef } from "react";
import { marksFor, setSourceMarks } from "../lib/source-marks";

/**
 * Marks, remembered per source — the restore/save sequencing lifted out of
 * App.tsx so it can be tested, which is how its second bug was provable.
 *
 * Restore and save are sequenced through one ref rather than run as two
 * independent effects, because independently they fight: the save effect
 * fires on the render where marks are still null for a source whose stored
 * marks have not been read yet, and writes that null straight over them.
 *
 * The ref holds THREE states, not two, and both extra states earned their
 * place from a shipped bug:
 *
 *   null                    no source is loaded, or it just unloaded.
 *   "restoring:<key>"       the restore's setState is issued but has not
 *                           landed; saving is still forbidden.
 *   <key>                   this source's stored marks are accounted for;
 *                           saves may write through.
 *
 * Why null on unload matters: re-opening the SAME source runs the reset
 * (marks to null, key to null) and then brings the same key back. A latch
 * that only ever filled meant the restore skipped on the way back in, and
 * the save effect then wrote the reset's nulls over the stored row - so
 * re-opening a source erased its marks. Unload clears the latch.
 *
 * Why "restoring" matters: the restore's setInFrames lands on the NEXT
 * render, but the save effect runs in the SAME commit as the restore, with
 * the pre-restore nulls still in its closure. A plain one-step latch let
 * that save delete the row the restore was in the middle of repopulating
 * (setSourceMarks treats a double-null as "forget the entry"). The save
 * effect completes the handshake instead: it sees "restoring", and only
 * once a non-null mark reaches it does it flip the latch and write.
 */
export function useSourceMarks(deps: {
  reviewSourceKey: string | null;
  fps?: number;
  durationFrames: number;
  inFrames: number | null;
  outFrames: number | null;
  setInFrames: (v: number | null) => void;
  setOutFrames: (v: number | null) => void;
}): void {
  const { reviewSourceKey, fps, durationFrames, inFrames, outFrames, setInFrames, setOutFrames } = deps;

  const latchRef = useRef<string | null>(null);
  const restoringRef = useRef<{ inFrames: number | null; outFrames: number | null } | null>(null);
  // A late metadata rate must restore in the new frame clock before saving.
  const latchKey = JSON.stringify([reviewSourceKey, fps]);

  useEffect(() => {
    if (!reviewSourceKey) {
      latchRef.current = null;
      restoringRef.current = null;
      return;
    }
    if (
      latchRef.current === latchKey ||
      latchRef.current === `restoring:${latchKey}`
    ) return;
    const stored = marksFor(reviewSourceKey, fps);
    if (stored.inFrames === null && stored.outFrames === null) {
      // Nothing to restore; saves may proceed at once. (Writing a double-null
      // to an absent row is a no-op in the store, so this cannot erase.)
      latchRef.current = latchKey;
      return;
    }
    // Clamp to THIS source: a stored mark can outlive a re-encode that made
    // the file shorter, and a mark past the end is one the export refuses.
    const max = durationFrames > 0 ? durationFrames - 1 : Infinity;
    const inF = stored.inFrames !== null ? Math.min(stored.inFrames, max) : null;
    const outF = stored.outFrames !== null ? Math.min(stored.outFrames, max) : null;
    if (inF !== null && outF !== null && outF <= inF) {
      latchRef.current = latchKey;
      return;
    }
    setInFrames(inF);
    setOutFrames(outF);
    restoringRef.current = { inFrames: inF, outFrames: outF };
    latchRef.current = `restoring:${latchKey}`;
  }, [reviewSourceKey, fps, latchKey, durationFrames, setInFrames, setOutFrames]);

  useEffect(() => {
    if (!reviewSourceKey) return;
    if (latchRef.current === `restoring:${latchKey}`) {
      // The restored state has not landed in this closure yet.
      if (inFrames !== restoringRef.current?.inFrames || outFrames !== restoringRef.current?.outFrames) return;
      restoringRef.current = null;
      latchRef.current = latchKey;
    }
    if (latchRef.current !== latchKey) return;
    setSourceMarks(reviewSourceKey, { inFrames, outFrames, ...(fps === undefined ? {} : { frameRate: fps }) });
  }, [reviewSourceKey, fps, latchKey, inFrames, outFrames]);

  useEffect(() => {
    // The restore clamps against the duration known AT RESTORE TIME, and a
    // cold web fetch restores before the real duration lands (the metadata
    // stub carries no duration, so max was Infinity). When it does land,
    // pull any mark past the new end back in; if that collapses the range,
    // drop both, which is what the restore would have done had it known.
    if (!(durationFrames > 0)) return;
    const max = durationFrames - 1;
    const inOver = inFrames !== null && inFrames > max;
    const outOver = outFrames !== null && outFrames > max;
    if (!inOver && !outOver) return;
    const inF = inOver ? max : inFrames;
    const outF = outOver ? max : outFrames;
    if (inF !== null && outF !== null && outF <= inF) {
      setInFrames(null);
      setOutFrames(null);
      return;
    }
    if (inOver) setInFrames(inF);
    if (outOver) setOutFrames(outF);
  }, [durationFrames, inFrames, outFrames, setInFrames, setOutFrames]);
}
