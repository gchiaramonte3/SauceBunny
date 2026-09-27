import { useEffect, useRef, useState } from "react";

/** "record" is the edit; anything else is a source id. */
export type TeTarget = string;

/**
 * Playheads for the edit and every source, and one clock that moves whichever
 * is playing (only one plays at a time, as in any source/record editor).
 * Scrubbing pauses playback and picks it up again from where you let go, so
 * a drag never fights the clock.
 */
export function useTePlayback(limits: Record<TeTarget, number>) {
  const [heads, setHeads] = useState<Record<TeTarget, number>>({ record: 0 });
  const [play, setPlay] = useState<{ target: TeTarget; from: number; at: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const resume = useRef<TeTarget | null>(null);
  const lastScrub = useRef<Record<TeTarget, number>>({});
  const limit = play ? limits[play.target] ?? 0 : 0;

  useEffect(() => {
    if (!play) return;
    let frame = 0;
    const tick = (now: number) => {
      const position = play.from + Math.max(0, now - play.at) / 1000;
      if (position >= limit) { setHeads((current) => ({ ...current, [play.target]: limit })); setPlay(null); return; }
      setHeads((current) => ({ ...current, [play.target]: position }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [play, limit]);

  const head = (target: TeTarget) => heads[target] ?? 0;
  const seek = (target: TeTarget, value: number) => {
    const at = Math.max(0, Math.min(limits[target] ?? 0, value));
    lastScrub.current[target] = at;
    setHeads((current) => ({ ...current, [target]: at }));
    if (play?.target === target) setPlay({ target, from: at, at: performance.now() });
  };
  const toggle = (target: TeTarget) => {
    if (play?.target === target) return setPlay(null);
    const from = head(target) >= (limits[target] ?? 0) - 0.01 ? 0 : head(target);
    setHeads((current) => ({ ...current, [target]: from }));
    setPlay({ target, from, at: performance.now() });
  };
  const scrubStart = () => {
    setScrubbing(true);
    if (play) { resume.current = play.target; setPlay(null); }
  };
  const scrubEnd = () => {
    setScrubbing(false);
    const target = resume.current;
    resume.current = null;
    if (target) setPlay({ target, from: lastScrub.current[target] ?? head(target), at: performance.now() });
  };
  return { head, playing: play?.target ?? null, scrubbing, seek, toggle, scrubStart, scrubEnd, stop: () => setPlay(null) };
}
