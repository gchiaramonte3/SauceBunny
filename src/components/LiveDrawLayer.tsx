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
 *
 * THE LOOP IDLES WHEN THERE IS NOTHING TO FADE, and that is a correctness
 * property of the whole app rather than a micro-optimisation.
 *
 * This layer is mounted for the ENTIRE session, whether or not anyone ever
 * picks up the pen. Its first version re-scheduled unconditionally, so an
 * empty room still cleared a device-pixel-sized canvas sixty times a second:
 * at DPR 2 over a large monitor box that is millions of pixels per frame, plus
 * a compositor update every frame, for hours. Nothing was visible, so nothing
 * looked wrong - it was paid for by everything ELSE on the stage, and the
 * clearest symptom was scrubbing a web source feeling slower inside a session
 * than the identical scrub in the clip panel, which mounts no such layer.
 *
 * So the loop runs only while strokes exist. When the last one fades the frame
 * that clears it is the last frame scheduled; an arriving stroke (or a resize,
 * which blanks the canvas by definition) wakes it again. Guarded by
 * LiveDrawLayer.test.tsx, which fails if an idle layer schedules a second
 * frame.
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

  /** Wakes the paint loop. Set by the mount effect; called by the wake effect
   *  below and by the resize observer. */
  const wakeRef = useRef<() => void>(() => {});

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
    // Resizing a canvas BLANKS it, so a live stroke has to be repainted or it
    // disappears on any layout change. Waking is free when nothing is live.
    const ro = new ResizeObserver(() => { fit(); wake(); });
    ro.observe(wrap);

    let raf = 0;
    let running = false;
    let disposed = false;
    const wake = () => {
      if (running || disposed) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    const frame = () => {
      const ctx = cv.getContext("2d");
      if (!ctx) { running = false; return; }
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

      // Stop rather than re-schedule once the room's marks are gone. The frame
      // above has already cleared the canvas, so what is on screen is correct
      // and stays correct until something wakes us. Note this reads state
      // AFTER onExpire: a stroke that just faded is still in `strokes` until
      // React re-renders, so we run one more frame and stop on the next.
      if (stateRef.current.strokes.length === 0) { running = false; return; }
      raf = requestAnimationFrame(frame);
    };
    wakeRef.current = wake;
    // A stroke may already be present on mount (re-mount mid-session).
    if (stateRef.current.strokes.length > 0) wake();
    return () => {
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // Wake on arrival. `state` is a new object per draw op, so this fires when
  // the room draws and never while the room is idle.
  useEffect(() => {
    if (state.strokes.length > 0) wakeRef.current();
  }, [state]);

  return (
    <div ref={wrapRef} className="cp-livedraw" aria-hidden>
      <canvas ref={canvasRef} className="cp-livedraw-canvas" />
    </div>
  );
}
