import { useEffect, useRef, useState } from "react";
import { PLAYBACK_RATES, formatPlaybackRate } from "../lib/playback-rate";

type Props = {
  /** Current persistent playback rate (one of PLAYBACK_RATES). */
  rate: number;
  onRateChange: (r: number) => void;
};

/**
 * Compact playback-speed picker for the transport bar — same interaction
 * pattern as its sibling VolumeControl: a small badge button that opens a
 * popover. Left-click opens the rate menu; right-click resets straight to 1×
 * (mirroring the volume button's right-click-to-mute). App owns persistence
 * (`saucebunny.playbackRate`) and pushes the rate to the active player.
 */
export function SpeedControl({ rate, onRateChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="cp-speed" ref={ref}>
      <button
        type="button"
        className={"cp-icon-btn speed" + (rate !== 1 ? " engaged" : "") + (open ? " active" : "")}
        title="Playback speed — right-click to reset to 1×"
        aria-label={`Playback speed: ${formatPlaybackRate(rate)}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => { e.preventDefault(); onRateChange(1); }}
      >
        {formatPlaybackRate(rate)}
      </button>
      {open && (
        <div className="cp-speed-popover" role="menu" aria-label="Playback speed">
          {PLAYBACK_RATES.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitemradio"
              aria-checked={r === rate}
              className={"cp-speed-option" + (r === rate ? " current" : "")}
              onClick={() => { onRateChange(r); setOpen(false); }}
            >
              {formatPlaybackRate(r)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
