import { useEffect, useRef } from "react";
import { liveStrokeAlpha, paintStroke } from "../lib/draw-paint";
import type { DrawState, DrawStroke } from "../lib/draw-ops";

/**
 * Live telestration: everyone's strokes over the picture, fading out.
 *
 * This is the READ side. It never captures input (`pointer-events: none`) and
 * never writes anything: strokes arrive as `liveDraw` from the session hook,
 * are painted, and disappear. Nothing here can reach the review doc, which is
 * the whole point of the feature - a note is a deliberate act, and pointing at
 * something on screen is not.
 *
 * AGE IS MEASURED LOCALLY, NOT FROM `stroke.at`.
 *
 * `at` is the AUTHOR's wall clock (draw-ops.ts calls it "paint order, not
 * causality"), so it is only good for deciding what covers what. Fading on it
 * would mean a peer whose clock is two minutes fast draws strokes that never
 * fade, and one whose clock is behind draws strokes that vanish on arrival.
 * Neither is a bug anyone would diagnose from the symptom. So the layer stamps
 * each stroke id the first time it SEES it and ages from that.
 */

export function LiveDrawLayer({ state, fadeSec, onExpire }: {
  /** The room's live strokes, already in paint order (`at` then `id`). */
  state: DrawState;
  /** Seconds a stroke holds before fading. 0 = hold until cleared. */
  fadeSec: number;
  /** Fired with the ids that have fully faded, so the owner can drop them.
   *  Rendering alone would leave a session's worth of invisible strokes in
   *  memory and in every repaint. */
  onExpire?: (ids: string[]) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** id → local ms when this layer first painted it. See the header note. */
  const seenRef = useRef<Map<string, number>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;
  const fadeRef = useRef(fadeSec);
  fadeRef.current = fadeSec;
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;

    // The monitor box is re-sized inline on every layout frame by
    // useContainSize, so this observes its OWN wrapper rather than measuring
    // once at mount.
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
      cv.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const w = cv.width, h = cv.height;
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, w, h);

      const now = Date.now();
      const hold = fadeRef.current * 1000;
      const seen = seenRef.current;
      const live = stateRef.current.strokes;
      const alive = new Set<string>();
      const expired: string[] = [];

      for (const s of live) {
        alive.add(s.id);
        let first = seen.get(s.id);
        if (first === undefined) { first = now; seen.set(s.id, now); }
        const alpha = liveStrokeAlpha(now - first, hold);
        if (alpha <= 0) { expired.push(s.id); continue; }
        paintStroke(ctx, s as DrawStroke, w, h, dpr, { alpha });
      }
      // Forget ids that are gone from state, or the map grows for the session.
      for (const id of seen.keys()) if (!alive.has(id)) seen.delete(id);
      if (expired.length && expireRef.current) expireRef.current(expired);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div ref={wrapRef} className="cp-livedraw" aria-hidden>
      <canvas ref={canvasRef} className="cp-livedraw-canvas" />
    </div>
  );
}
