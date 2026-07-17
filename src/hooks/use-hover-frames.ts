import { useCallback, useEffect, useRef, useState } from "react";
import { requestHoverFrames } from "./use-library-scan";

/** Hover dwell before any decode work starts — a drive-by never costs a frame. */
const INTENT_MS = 600;
/** Cycle cadence once frames are showing. */
const CYCLE_MS = 1200;

/** Who is holding the cycle open — the pointer or keyboard focus. */
export type HoverIntentSource = "hover" | "focus";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/**
 * Hover frame cycling for local-video LibraryCards (the Game Scoop preview):
 * hovering or focusing a card for 600ms lazily decodes up to three extra
 * frames (25/50/75% of duration — requestHoverFrames rides the shared
 * thumbnail cache, decode gate, and generation guard in use-library-scan),
 * then cross-dissolves poster → f25 → f50 → f75 → poster… every 1.2s.
 *
 * Hover and focus are SEPARATE intents: a cycle stays alive while either
 * holds it, so a blur can't kill a pointer-owned cycle (or vice versa) —
 * teardown only happens when the last intent ends. `active` indexes
 * `frames`; -1 means the poster owns the art. Losing both intents, the tab
 * hiding, reduced-motion flipping on, or unmount clears both timers and
 * empties `frames`, so the card snaps straight back to its poster (the
 * overlays unmount — no exit animation to fight). Never starts for a null
 * path (remote/audio cards) or under prefers-reduced-motion, and never
 * decodes on render — only after the intent timer fires.
 */
export function useHoverFrames(path: string | null): {
  /** Cross-dissolve overlay URLs — empty until a cycle is actually running. */
  frames: string[];
  /** Index into `frames` currently shown; -1 → the poster. */
  active: number;
  /** Bind to mouseenter ("hover") / focus ("focus") — arms the intent timer
   *  on the first intent; a second source just latches on. */
  start: (source: HoverIntentSource) => void;
  /** Bind to mouseleave/blur with the matching source — snaps back to the
   *  poster only once BOTH intents are gone. */
  stop: (source: HoverIntentSource) => void;
} {
  const [frames, setFrames] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const intentTimer = useRef<number | null>(null);
  const cycleTimer = useRef<number | null>(null);
  /** Per-source intent flags — the async frame fetch checks them on resolve. */
  const hoverRef = useRef(false);
  const focusRef = useRef(false);

  /** Full teardown — clears BOTH intents (visibility/reduced-motion/unmount). */
  const teardown = useCallback(() => {
    hoverRef.current = false;
    focusRef.current = false;
    if (intentTimer.current != null) {
      window.clearTimeout(intentTimer.current);
      intentTimer.current = null;
    }
    if (cycleTimer.current != null) {
      window.clearInterval(cycleTimer.current);
      cycleTimer.current = null;
    }
    setActive(-1);
    setFrames([]);
  }, []);

  const stop = useCallback((source: HoverIntentSource) => {
    if (source === "hover") hoverRef.current = false;
    else focusRef.current = false;
    // The other source still owns the cycle — a blur must not kill a
    // pointer-held cycle (or a mouseleave a focus-held one).
    if (hoverRef.current || focusRef.current) return;
    teardown();
  }, [teardown]);

  const start = useCallback((source: HoverIntentSource) => {
    if (!path || reducedMotion.matches) return;
    const had = hoverRef.current || focusRef.current;
    if (source === "hover") hoverRef.current = true;
    else focusRef.current = true;
    if (had) return; // already engaged — the second source just latches on
    intentTimer.current = window.setTimeout(() => {
      intentTimer.current = null;
      void requestHoverFrames(path).then((urls) => {
        // Both intents left while decoding (or a second start already cycled):
        // the frames stay in the module cache for the next hover — show
        // nothing now.
        const engaged = hoverRef.current || focusRef.current;
        if (!engaged || cycleTimer.current != null || urls.length === 0) return;
        setFrames(urls);
        setActive(0); // first dissolve: poster → f25
        let step = 0;
        cycleTimer.current = window.setInterval(() => {
          step = (step + 1) % (urls.length + 1); // + the poster beat
          setActive(step === urls.length ? -1 : step);
        }, CYCLE_MS);
      });
    }, INTENT_MS);
  }, [path]);

  // The tab hiding kills the cycle — timers must not churn behind a hidden app.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) teardown();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [teardown]);

  // Reduced motion flipping ON mid-cycle stops it immediately — `start`
  // only checks the query at intent time, so a running cycle must listen.
  useEffect(() => {
    const onChange = () => {
      if (reducedMotion.matches) teardown();
    };
    reducedMotion.addEventListener("change", onChange);
    return () => reducedMotion.removeEventListener("change", onChange);
  }, [teardown]);

  // Unmount (or a recycled card getting a new path) kills the cycle too.
  useEffect(() => teardown, [path, teardown]);

  return { frames, active, start, stop };
}
