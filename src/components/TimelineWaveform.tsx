import { useEffect, useRef } from "react";
import type { WaveformPeaks } from "../lib/waveform";

type Props = {
  peaks: WaveformPeaks;
  /** Timeline's measured track width (already bucketed to 24px by its
   *  ResizeObserver) — a dep so a real resize redraws at the new size. */
  widthPx: number;
};

/**
 * The audio waveform lane of the scrub track: mirrored min/max peaks around
 * a centre axis, drawn into a canvas that fills the track. Dumb renderer —
 * peak extraction (and its caching/cancellation) lives in the Timeline
 * effect + `lib/waveform.ts`. Deliberately muted so the playhead, marks,
 * comment markers and speaker lanes stay visually dominant.
 */
export function TimelineWaveform({ peaks, widthPx }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current) drawWaveform(ref.current, peaks);
  }, [peaks, widthPx]);

  return <canvas ref={ref} className="cp-track-wave" aria-hidden />;
}

function drawWaveform(canvas: HTMLCanvasElement, peaks: WaveformPeaks) {
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Ink comes from the muted-foreground token so theming stays in
  // tokens.css — canvas can't use `var()` directly, so resolve it here.
  // No hardcoded fallback: --fg-4 is always defined on :root, and the literal
  // that used to sit here (#71717A) is now --fg-5's value — the r141 contrast
  // lift moved fg-4 away from it, so the fallback named a colour the palette
  // had deliberately abandoned. (Not `currentColor`: as a canvas fillStyle it
  // resolves to the inherited `color`, and an unparseable value paints black.)
  const ink = getComputedStyle(canvas).getPropertyValue("--fg-4").trim();
  ctx.clearRect(0, 0, w, h);

  const { mins, maxs } = peaks;
  const count = mins.length;
  if (count === 0) return;
  const cy = h / 2;
  // Keep peaks clear of the track edges and the 5px speaker-lane strip
  // hugging the bottom.
  const amp = Math.max(2, cy - 6 * dpr);

  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.5;
  // One vertical bar per device-pixel column, aggregating every bucket the
  // column covers so narrow tracks never drop transient peaks.
  for (let x = 0; x < w; x++) {
    const b0 = Math.floor((x / w) * count);
    const b1 = Math.min(count, Math.max(b0 + 1, Math.ceil(((x + 1) / w) * count)));
    let mn = 0;
    let mx = 0;
    for (let b = b0; b < b1; b++) {
      if (mins[b] < mn) mn = mins[b];
      if (maxs[b] > mx) mx = maxs[b];
    }
    const yTop = cy - mx * amp;
    ctx.fillRect(x, yTop, 1, Math.max(dpr * 0.75, (mx - mn) * amp));
  }

  // Hairline centre axis so silent stretches still read as an audio lane.
  ctx.globalAlpha = 0.18;
  ctx.fillRect(0, cy - 0.5, w, 1);
}
