import { memo, useEffect, useMemo, useRef, useState } from "react";
import { TimelineWaveform } from "./TimelineWaveform";

/** Reuse Clip's device-pixel min/max canvas, including peak-preserving reduction. */
export const MultitrackWaveform = memo(function MultitrackWaveform({ peaks, from, to }: { peaks: number[][]; from: number; to: number }) {
  const ref = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) }));
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  const visible = useMemo(() => {
    const slice = peaks.slice(Math.max(0, Math.floor(from * peaks.length)), Math.min(peaks.length, Math.ceil(to * peaks.length)));
    return { mins: Float32Array.from(slice, (pair) => pair[0]), maxs: Float32Array.from(slice, (pair) => pair[1]) };
  }, [peaks, from, to]);
  return <div ref={ref} className="cp-multitrack-waveform"><TimelineWaveform key={size.height} peaks={visible} widthPx={size.width} colorful /></div>;
});
