import { useEffect, useRef, useState } from "react";
import { extractWaveformPeaks } from "../lib/waveform";
import { waveformBars, waveformPath } from "../lib/waveform-art";
import { IconVolume } from "./Icons";

/** How many bars a card draws. Enough to show speech rhythm, few enough that
 *  the path string stays short on a wall of forty cards. */
const BARS = 44;

/**
 * A local audio file's card art: its own waveform.
 *
 * WHY THIS BEATS A GLYPH. Every audio file in the library drew the SAME
 * speaker icon, so a shelf of them was a wall of identical cards and the only
 * way to tell one from another was to read a hashed filename. A waveform is
 * real content — where the speech is, where the silence is, whether the file
 * is one long take or a stack of short ones — and it comes from the file
 * itself, so it distinguishes cards without inventing anything.
 *
 * DECODED LAZILY, ON INTERSECTION, and only once per path: extractWaveformPeaks
 * already caches, but the DECODE is the expensive half and firing it for forty
 * off-screen cards at scan time would fight the player for the main thread.
 * A card that has not been scrolled to has not paid for anything.
 *
 * THE GLYPH REMAINS THE FALLBACK. A file mediabunny cannot decode, or one still
 * decoding, shows exactly what it showed before. Nothing regresses to blank.
 */
export function WaveformArt({ path, color }: { path: string; color?: string }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [bars, setBars] = useState<number[] | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let stale = false;
    const ac = new AbortController();

    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void extractWaveformPeaks(path, { signal: ac.signal })
        .then((peaks) => {
          if (stale || !peaks) return;
          setBars(waveformBars(peaks, BARS));
        })
        // A codec mediabunny will not open keeps the glyph. Not an error state:
        // the card still says "audio", which was all it ever said.
        .catch(() => { /* fall back to the glyph */ });
    }, { rootMargin: "200px" });

    io.observe(el);
    return () => { stale = true; ac.abort(); io.disconnect(); };
  }, [path]);

  return (
    <span ref={hostRef} className="cp-wave-art">
      {bars ? (
        <svg
          className="cp-wave-svg"
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d={waveformPath(bars, 100, 40)} fill={color ?? "currentColor"} />
        </svg>
      ) : (
        <IconVolume size={22} />
      )}
    </span>
  );
}
