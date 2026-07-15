import { useEffect, useRef, useState } from "react";
import { extractFrameAsBlob } from "../lib/mediabunny-helpers";
import { createScrubPump, type ScrubPump } from "../lib/scrub-pump";
import { secondsToClock } from "../lib/timecode";

/**
 * The scrub half of ThumbnailPicker: a range slider over the file's duration
 * with a live frame preview. Dragging fires `onChange` many times a second, so
 * the decode runs through a createScrubPump — latest-wins, single-flight: the
 * pump coalesces to the newest requested time and never queues intermediate
 * decodes, so a fast drag chases the cursor instead of lagging behind a backlog
 * (mediabunny seeks to the nearest keyframe and decodes forward — expensive on
 * long-GOP media). Preview object URLs are revoked on replace and on unmount so
 * a long scrub never leaks decoded JPEGs.
 *
 * Controlled: the parent owns the chosen time `value` (its "Use this frame"
 * button reads it); this component owns only the transient preview + pump.
 */

type Props = {
  path: string;
  /** File duration in seconds — bounds the slider. */
  dur: number;
  /** The current chosen time (seconds). */
  value: number;
  onChange: (seconds: number) => void;
};

export function ThumbnailPickerSlider({ path, dur, value, onChange }: Props) {
  const [preview, setPreview] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const pumpRef = useRef<ScrubPump | null>(null);
  const aliveRef = useRef(true);

  // One pump per source. `drain` decodes the target frame and paints it,
  // revoking the frame it replaces. Rebuilt only when the path changes.
  useEffect(() => {
    aliveRef.current = true;
    const pump = createScrubPump(async (target) => {
      const blob = await extractFrameAsBlob(path, target, { maxWidth: 640 });
      if (!blob) return;
      // pump.cancel() only drops PENDING targets — a decode already in flight
      // when this component unmounts (e.g. Escape mid-drag) still completes, so
      // gate the paint. Without this, createObjectURL would run after cleanup
      // nulled previewRef, leaking that blob and setting state on an unmount.
      if (!aliveRef.current) return;
      const url = URL.createObjectURL(blob);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = url;
      setPreview(url);
    });
    pumpRef.current = pump;
    pump.request(value); // seed the preview at the initial time
    return () => {
      aliveRef.current = false;
      pump.cancel();
      pumpRef.current = null;
      if (previewRef.current) { URL.revokeObjectURL(previewRef.current); previewRef.current = null; }
      setPreview(null);
    };
    // Seeding uses the value at mount; later value changes drive the pump below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Every slider move requests the newest target — the pump drops any in-between.
  useEffect(() => { pumpRef.current?.request(value); }, [value]);

  const step = Math.max(0.05, dur / 1000);

  return (
    <>
      <div className="cp-lib-thumb-preview">
        {preview
          ? <img src={preview} alt="" draggable={false} />
          : <span className="cp-lib-thumb-ph">Generating…</span>}
      </div>
      <div className="cp-lib-thumb-slider">
        <input
          type="range"
          min={0}
          max={dur}
          step={step}
          value={value}
          autoFocus
          aria-label="Thumbnail time"
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="cp-lib-thumb-time">{secondsToClock(value)}</span>
      </div>
    </>
  );
}
