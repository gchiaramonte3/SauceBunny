import { useEffect, useRef } from "react";
import { tePeaks } from "./transcript-editor-fixture";

/** One clip's generated waveform, drawn in the lane's speaker colour. */
export function TeWave({ speaker, srcIn, srcOut, muted }: { speaker: string; srcIn: number; srcOut: number; muted: [number, number][] }) {
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
      const peaks = tePeaks(speaker, srcIn, srcOut, Math.min(w, 1200));
      const ink = getComputedStyle(canvas).color;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = ink;
      const cy = h / 2, amp = cy - 2 * dpr;
      peaks.forEach(([min, max], index) => {
        const t = srcIn + ((index + 0.5) / peaks.length) * (srcOut - srcIn);
        ctx.globalAlpha = muted.some(([a, b]) => t >= a && t <= b) ? 0.18 : 0.85;
        const x = (index / peaks.length) * w;
        ctx.fillRect(x, cy - max * amp, Math.max(1, w / peaks.length - 0.25), Math.max(dpr * 0.75, (max - min) * amp));
      });
      ctx.globalAlpha = 0.2;
      ctx.fillRect(0, cy - 0.5, w, 1);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [speaker, srcIn, srcOut, muted]);
  return <canvas ref={ref} className="cp-te-wave" aria-hidden="true" />;
}
