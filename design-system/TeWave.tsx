import { useEffect, useRef } from "react";
import { tePeaks } from "./transcript-editor-fixture";

/** One clip's generated waveform, in the lane's ink. A lifted stretch draws
 *  flat, or as a low bed of room tone when that is switched on. */
export function TeWave({ source, speaker, srcIn, srcOut, muted, roomTone }: { source: string; speaker: string; srcIn: number; srcOut: number; muted: [number, number][]; roomTone: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      // A zoomed clip can be tens of thousands of pixels wide; a canvas cannot.
      const w = Math.max(1, Math.min(8192, Math.round(canvas.clientWidth * dpr))), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const peaks = tePeaks(source, speaker, srcIn, srcOut, Math.min(w, 1200));
      const ink = getComputedStyle(canvas).color;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = ink;
      const cy = h / 2, amp = cy - 2 * dpr;
      peaks.forEach(([min, max], index) => {
        const t = srcIn + ((index + 0.5) / peaks.length) * (srcOut - srcIn);
        const lifted = muted.some(([a, b]) => t >= a && t <= b);
        const scale = lifted ? (roomTone ? 0.08 + 0.04 * Math.abs(Math.sin(index * 1.7)) : 0) : 1;
        ctx.globalAlpha = lifted ? (roomTone ? 0.55 : 0.18) : 0.85;
        const x = (index / peaks.length) * w;
        const top = lifted ? scale : max, bottom = lifted ? -scale : min;
        ctx.fillRect(x, cy - top * amp, Math.max(1, w / peaks.length - 0.25), Math.max(dpr * 0.75, (top - bottom) * amp));
      });
      ctx.globalAlpha = 0.2;
      ctx.fillRect(0, cy - 0.5, w, 1);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [source, speaker, srcIn, srcOut, muted, roomTone]);
  return <canvas ref={ref} className="cp-te-wave" aria-hidden="true" />;
}
