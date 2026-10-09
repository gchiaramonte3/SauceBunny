import { useEffect, useRef, useState } from "react";

export type Peaks = [number, number][];

type Props = {
  /** A whole source track's overview: [min, max] pairs spread over `duration` seconds. */
  peaks: Peaks | undefined; duration: number;
  /** The clip's source range, which the canvas's parent spans. */
  srcIn: number; srcOut: number;
  /** The part of it on screen; only that is drawn. Defaults to the whole clip. */
  from?: number; to?: number;
  /** Finer peaks for a source range of the lane `detailKey` names, from the cached pyramid, when the overview is too coarse to draw it. */
  detail?: (key: string, from: number, to: number) => Promise<Peaks | null>; detailKey?: string;
};

/** Below this many overview points per drawn column, the overview is stretched: ask for detail. */
const POINTS_PER_COLUMN = 0.5;
/** A pan or zoom settles before detail is asked for. */
const DETAIL_DELAY_MS = 120;

/**
 * One clip's waveform, from AAF Audio's cached pyramid (nothing is decoded
 * for the editor), in the lane's ink. Only the part of the clip on screen is
 * drawn. The whole-sequence overview has 2,048 points: across a 3-hour mic
 * that is about 5 s a point, so a clip a few seconds long drew as one solid
 * block. When the overview is that coarse for what is on screen, the visible
 * range is asked for at its own resolution and drawn when it arrives.
 * A silenced stretch is never drawn: the timeline cuts the clip there instead.
 */
export function EditWave({ peaks, duration, srcIn, srcOut, from = srcIn, to = srcOut, detail, detailKey }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [fine, setFine] = useState<{ from: number; to: number; peaks: Peaks } | null>(null);
  const shownFrom = Math.max(srcIn, from), shownTo = Math.min(srcOut, to);

  // Detail, when the overview is too coarse for what is on screen.
  useEffect(() => {
    if (!detail || !detailKey || !peaks?.length || duration <= 0 || shownTo <= shownFrom) return;
    const canvas = ref.current;
    const columns = Math.max(1, Math.min(1200, canvas?.clientWidth ?? 600));
    const points = ((shownTo - shownFrom) / duration) * peaks.length;
    if (points / columns >= POINTS_PER_COLUMN) { setFine(null); return; }
    if (fine && fine.from <= shownFrom && fine.to >= shownTo && (fine.to - fine.from) <= (shownTo - shownFrom) * 4) return;
    // A little either side, so a short pan does not ask again.
    const pad = (shownTo - shownFrom) * 0.5;
    const ask = [Math.max(srcIn, shownFrom - pad), Math.min(srcOut, shownTo + pad)] as const;
    let live = true;
    const timer = window.setTimeout(() => {
      void detail(detailKey, ask[0], ask[1]).then((found) => { if (live && found?.length) setFine({ from: ask[0], to: ask[1], peaks: found }); });
    }, DETAIL_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [detail, detailKey, peaks, duration, srcIn, srcOut, shownFrom, shownTo, fine]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !peaks?.length || duration <= 0 || shownTo <= shownFrom) return;
    const draw = () => {
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const w = Math.max(1, Math.min(8192, Math.round(canvas.clientWidth * dpr))), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = getComputedStyle(canvas).color;
      const cy = h / 2, amp = cy - 2 * dpr;
      // The finer peaks when they cover what is shown, else the overview.
      const useFine = fine && fine.from <= shownFrom + 1e-6 && fine.to >= shownTo - 1e-6;
      const data = useFine ? fine.peaks : peaks;
      const base = useFine ? fine.from : 0, length = useFine ? fine.to - fine.from : duration;
      const first = ((shownFrom - base) / length) * data.length, span = ((shownTo - shownFrom) / length) * data.length;
      const columns = Math.max(1, Math.min(w, 1200));
      for (let column = 0; column < columns; column++) {
        const a = Math.floor(first + (column / columns) * span), b = Math.max(a + 1, Math.floor(first + ((column + 1) / columns) * span));
        let low = 0, high = 0;
        for (let index = Math.max(0, a); index < Math.min(data.length, b); index++) { low = Math.min(low, data[index][0]); high = Math.max(high, data[index][1]); }
        ctx.globalAlpha = 0.85;
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
  }, [peaks, duration, shownFrom, shownTo, fine]);

  const length = Math.max(1e-9, srcOut - srcIn);
  return <canvas ref={ref} className="cp-te-wave" aria-hidden="true"
    style={{ left: `${((shownFrom - srcIn) / length) * 100}%`, width: `${((shownTo - shownFrom) / length) * 100}%` }} />;
}
