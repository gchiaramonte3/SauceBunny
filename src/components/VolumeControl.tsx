import { useRef, useState } from "react";
import { IconVolume, IconVolumeMuted } from "./Icons";
import { usePopoverDismiss } from "../hooks/use-popover-dismiss";

type Props = {
  /** 0..1 */
  volume: number;
  muted: boolean;
  onVolumeChange: (v: number) => void;
  onMutedChange: (m: boolean) => void;
};

export function VolumeControl({ volume, muted, onVolumeChange, onMutedChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  usePopoverDismiss(open, [ref], () => setOpen(false));

  const effectivelyMuted = muted || volume === 0;

  return (
    <div className="cp-volume" ref={ref}>
      <button
        type="button"
        className={"cp-icon-btn volume" + (effectivelyMuted ? " muted" : "") + (open ? " active" : "")}
        title={effectivelyMuted ? "Unmute" : "Volume"}
        aria-label={effectivelyMuted ? "Volume (muted)" : "Volume"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => { e.preventDefault(); onMutedChange(!muted); }}
      >
        {effectivelyMuted ? <IconVolumeMuted size={15} /> : <IconVolume size={15} />}
      </button>
      {open && (
        <div className="cp-volume-popover">
          <button
            type="button"
            className="cp-volume-mute"
            onClick={() => onMutedChange(!muted)}
            title={muted ? "Unmute" : "Mute"}
            aria-label={muted ? "Unmute" : "Mute"}
          >
            {muted ? <IconVolumeMuted size={13} /> : <IconVolume size={13} />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => onVolumeChange(parseInt(e.target.value, 10) / 100)}
            className="cp-volume-slider"
            aria-label="Volume"
          />
          <span className="cp-volume-value">{Math.round(volume * 100)}</span>
        </div>
      )}
    </div>
  );
}
