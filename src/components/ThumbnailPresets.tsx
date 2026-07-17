import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { secondsToClock } from "../lib/timecode";

/**
 * The preset half of ThumbnailPicker: the fallback for files mediabunny can't
 * decode (no in-app scrub preview possible). Renders three sample frames via
 * the ffmpeg `generate_local_thumbnail` sidecar at the given offsets (10% / 33%
 * / 66% of duration, or fixed 2s/10s/30s when the duration is unknown too).
 * Clicking a tile confirms it (`onPick`), which persists that time_seconds.
 */

type Props = {
  path: string;
  /** Preset times in seconds, in display order. */
  offsets: number[];
  /** File duration if known — forwarded to the sidecar for its seek math. */
  dur: number | null;
  /** True when the offsets are the duration-less fixed fallback. */
  approx: boolean;
  hasChosen: boolean;
  onPick: (seconds: number) => void;
  onResetAuto: () => void;
  onClose: () => void;
};

export function ThumbnailPresets({ path, offsets, dur, approx, hasChosen, onPick, onResetAuto, onClose }: Props) {
  // Rendered frames, index-aligned to `offsets` (null = pending/failed).
  const [urls, setUrls] = useState<(string | null)[]>(() => offsets.map(() => null));

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rendered = await Promise.all(offsets.map(async (sec) => {
        try {
          const out = await invoke<string>("generate_local_thumbnail", {
            args: { input_path: path, duration_seconds: dur, time_seconds: sec },
          });
          return typeof out === "string" && out !== "" ? convertFileSrc(out) : null;
        } catch {
          return null;
        }
      }));
      if (alive) setUrls(rendered);
    })();
    return () => { alive = false; };
    // offsets/dur are fixed for a given picker open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <>
      <div className="cp-lib-thumb-presets" role="group" aria-label="Thumbnail choices">
        {offsets.map((sec, i) => (
          <button
            key={sec}
            type="button"
            className="cp-lib-thumb-preset"
            onClick={() => onPick(sec)}
            title={`Use ${secondsToClock(sec)}`}
          >
            {urls[i]
              ? <img src={urls[i]!} alt="" draggable={false} />
              : <span className="cp-lib-thumb-ph">…</span>}
            <span className="cp-lib-thumb-preset-time">{secondsToClock(sec)}</span>
          </button>
        ))}
      </div>
      <p className="cp-lib-thumb-note">
        {approx
          ? "This file can't be scrubbed and its length is unknown. Pick a sample frame."
          : "This file can't be scrubbed here. Pick a sample frame."}
      </p>
      <div className="cp-lib-thumb-actions">
        {hasChosen && <button type="button" className="btn" onClick={onResetAuto}>Reset to auto</button>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </>
  );
}
