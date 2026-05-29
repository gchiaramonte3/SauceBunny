import {
  IconPlay, IconPause, IconSkipBack, IconSkipForward,
  IconMarkIn, IconMarkOut, IconClearMarks, IconCaptions, IconCamera,
} from "./Icons";
import { VolumeControl } from "./VolumeControl";
import type { AppStatus } from "../types";

type Props = {
  status: AppStatus;
  isPlaying: boolean;
  playheadTc: string;
  durationTc: string;
  captionsOn: boolean;
  snapshotBusy: boolean;
  canSnapshot: boolean;
  volume: number;
  muted: boolean;
  onPlayToggle: () => void;
  onStep: (frames: number) => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onClearMarks: () => void;
  onToggleCaptions: () => void;
  onSnapshot: () => void;
  onVolumeChange: (v: number) => void;
  onMutedChange: (m: boolean) => void;
};

export function Transport({
  status, isPlaying,
  playheadTc, durationTc,
  captionsOn, snapshotBusy, canSnapshot,
  volume, muted,
  onPlayToggle, onStep, onMarkIn, onMarkOut, onClearMarks, onToggleCaptions, onSnapshot,
  onVolumeChange, onMutedChange,
}: Props) {
  const dim = status === "empty" || status === "fetching" || status === "error";
  return (
    <div
      className="cp-transport"
      style={{ opacity: dim ? 0.5 : 1, pointerEvents: dim ? "none" : "auto" }}
    >
      {/* LEFT — current playhead */}
      <div className="cp-transport-side left">
        <div className="cp-tc">{playheadTc}</div>
      </div>

      {/* CENTER — primary playback controls, dead center */}
      <div className="cp-transport-center">
        <button className="cp-transport-btn" title="Step back 1 frame (←)" onClick={() => onStep(-1)}>
          <IconSkipBack size={14} />
        </button>
        <button
          className={"cp-transport-btn play" + (isPlaying ? " active" : "")}
          title="Play / pause (K, Space)"
          onClick={onPlayToggle}
        >
          {isPlaying ? <IconPause size={16} /> : <IconPlay size={14} />}
        </button>
        <button className="cp-transport-btn" title="Step forward 1 frame (→)" onClick={() => onStep(1)}>
          <IconSkipForward size={14} />
        </button>
      </div>

      {/* RIGHT — marks, captions, duration */}
      <div className="cp-transport-side right">
        <div className="cp-icon-group">
          <button className="cp-icon-btn" title="Mark in (I)" onClick={onMarkIn}>
            <IconMarkIn size={15} />
          </button>
          <button className="cp-icon-btn" title="Mark out (O)" onClick={onMarkOut}>
            <IconMarkOut size={15} />
          </button>
          <button className="cp-icon-btn" title="Clear marks (G)" onClick={onClearMarks}>
            <IconClearMarks size={15} />
          </button>
        </div>
        <button
          className={"cp-icon-btn snapshot" + (snapshotBusy ? " busy" : "")}
          title="Save frame at playhead as image"
          onClick={onSnapshot}
          disabled={snapshotBusy || !canSnapshot}
        >
          <IconCamera size={15} />
        </button>
        <div className="cp-icon-divider" />
        <VolumeControl
          volume={volume}
          muted={muted}
          onVolumeChange={onVolumeChange}
          onMutedChange={onMutedChange}
        />
        <button
          className={"cp-icon-btn cc" + (captionsOn ? " active" : "")}
          title={captionsOn ? "Hide captions" : "Turn on captions"}
          onClick={onToggleCaptions}
        >
          <IconCaptions size={15} />
        </button>
        <div className="cp-tc duration">{durationTc}</div>
      </div>
    </div>
  );
}
