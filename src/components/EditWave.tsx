import { useEffect, useRef } from "react";

type Props = {
  /** A whole source track's overview: [min, max] pairs spread over `duration` seconds. */
  peaks: [number, number][] | undefined; duration: number;
  srcIn: number; srcOut: number;
  /** Silenced source ranges on this track, in source seconds. */
  muted: [number, number][];
};

/**
 * One clip's waveform, sliced from the source track's overview (AAF Audio's
 * cached pyramid, so nothing is decoded for the editor), in the lane's ink. A
 * silenced stretch draws flat.
 */
export function EditWave({ peaks, duration, srcIn, srcOut, muted }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !peaks?.length || duration <= 0) return;
    const draw = () => {
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      // A zoomed clip can be tens of thousands of pixels wide; a canvas cannot.
      const w = Math.max(1, Math.min(8192, Math.round(canvas.clientWidth * dpr))), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = getComputedStyle(canvas).color;
      const cy = h / 2, amp = cy - 2 * dpr;
      const first = (srcIn / duration) * peaks.length, span = ((srcOut - srcIn) / duration) * peaks.length;
      const columns = Math.max(1, Math.min(w, 1200));
      for (let column = 0; column < columns; column++) {
        const a = Math.floor(first + (column / columns) * span), b = Math.max(a + 1, Math.floor(first + ((column + 1) / columns) * span));
        let low = 0, high = 0;
        for (let index = Math.max(0, a); index < Math.min(peaks.length, b); index++) { low = Math.min(low, peaks[index][0]); high = Math.max(high, peaks[index][1]); }
        const t = srcIn + ((column + 0.5) / columns) * (srcOut - srcIn);
        const silent = muted.some(([from, to]) => t >= from && t <= to);
        if (silent) { low = 0; high = 0; }
        ctx.globalAlpha = silent ? 0.25 : 0.85;
        const x = (column / columns) * w;
        ctx.fillRect(x, cy - high * amp, Math.max(1, w / columns - 0.25), Math.max(dpr * 0.75, (high - low) * amp));
      }
      ctx.globalAlpha = 0.2;
      ctx.fillRect(0, cy - 0.5, w, 1);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, duration, srcIn, srcOut, muted]);
  return <canvas ref={ref} className="cp-te-wave" aria-hidden="true" />;
}
