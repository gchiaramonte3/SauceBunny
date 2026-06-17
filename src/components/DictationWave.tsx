import { useEffect, useRef } from "react";

/**
 * Wispr Flow-style mic waveform — a row of glowing purple bars that bounce with
 * your voice while dictating. Driven by a level ref (0..1) the parent feeds from
 * the backend's `dictate-level` events, read inside a rAF loop so 20 Hz level
 * updates never re-render React. Bars animate via GPU `transform: scaleY` (no
 * layout), with a center-weighted shape + per-bar wiggle so they feel alive even
 * in near-silence.
 */
const BARS = 7;
// Center-weighted base heights so the middle bars stand tallest.
const SHAPE = [0.45, 0.7, 0.9, 1.0, 0.9, 0.7, 0.45];

export function DictationWave({ levelRef, active }: { levelRef: React.RefObject<number>; active: boolean }) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const smoothRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let t = 0;
    const tick = () => {
      t += 0.09;
      const target = levelRef.current ?? 0;
      // Fast attack, gentle release so peaks pop and tails decay smoothly.
      const k = target > smoothRef.current ? 0.5 : 0.12;
      smoothRef.current += (target - smoothRef.current) * k;
      const lv = smoothRef.current;
      for (let i = 0; i < BARS; i++) {
        const el = barsRef.current[i];
        if (!el) continue;
        const wiggle = 0.78 + 0.22 * Math.sin(t * (1.3 + i * 0.21) + i * 1.7);
        // 0.12 idle floor (always alive) → grows with level, shaped per bar.
        const h = 0.12 + (0.1 + lv * 0.9) * SHAPE[i] * wiggle;
        el.style.transform = `scaleY(${Math.max(0.08, Math.min(1, h))})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, levelRef]);

  if (!active) return null;
  return (
    <div className="cp-dictwave" aria-hidden>
      {Array.from({ length: BARS }).map((_, i) => (
        <span key={i} ref={(el) => { barsRef.current[i] = el; }} className="cp-dictwave-bar" />
      ))}
    </div>
  );
}
