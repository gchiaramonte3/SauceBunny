import {
  IconPlay, IconPause, IconSkipBack, IconSkipForward,
  IconMarkIn, IconMarkOut, IconClearMarks, IconCaptions, IconCamera,
} from "./Icons";
import { VolumeControl } from "./VolumeControl";
import { SpeedControl } from "./SpeedControl";
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
  playbackRate: number;
  /** False while the active player can't honour a rate (WebCodecs player). */
  playbackRateSupported: boolean;
  onPlayToggle: () => void;
  onStep: (frames: number) => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onClearMarks: () => void;
  onToggleCaptions: () => void;
  onSnapshot: () => void;
  onVolumeChange: (v: number) => void;
  onMutedChange: (m: boolean) => void;
  onPlaybackRateChange: (r: number) => void;
};

export function Transport({
  status, isPlaying,
  playheadTc, durationTc,
  captionsOn, snapshotBusy, canSnapshot,
  volume, muted, playbackRate, playbackRateSupported,
  onPlayToggle, onStep, onMarkIn, onMarkOut, onClearMarks, onToggleCaptions, onSnapshot,
  onVolumeChange, onMutedChange, onPlaybackRateChange,
}: Props) {
  const dim = status === "empty" || status === "fetching" || status === "error";
  return (
    <div
      className="cp-transport"
      role="region"
      aria-label="Playback transport"
      style={{ opacity: dim ? 0.5 : 1, pointerEvents: dim ? "none" : "auto" }}
    >
      {/* LEFT — current playhead */}
      <div className="cp-transport-side left">
        <div className="cp-tc">{playheadTc}</div>
      </div>

      {/* CENTER — primary playback controls, dead center */}
      <div className="cp-transport-center">
        <button className="cp-transport-btn" title="Step back 1 frame (←)" aria-label="Step back one frame" onClick={() => onStep(-1)}>
          <IconSkipBack size={14} />
        </button>
        <button
          className={"cp-transport-btn play" + (isPlaying ? " active" : "")}
          title="Play / pause (K, Space)"
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={onPlayToggle}
        >
          {isPlaying ? <IconPause size={16} /> : <IconPlay size={14} />}
        </button>
        <button className="cp-transport-btn" title="Step forward 1 frame (→)" aria-label="Step forward one frame" onClick={() => onStep(1)}>
          <IconSkipForward size={14} />
        </button>
      </div>

      {/* RIGHT — marks, captions, duration */}
      <div className="cp-transport-side right">
        <div className="cp-icon-group">
          <button className="cp-icon-btn" title="Mark in (I)" aria-label="Mark in" onClick={onMarkIn}>
            <IconMarkIn size={15} />
          </button>
          <button className="cp-icon-btn" title="Mark out (O)" aria-label="Mark out" onClick={onMarkOut}>
            <IconMarkOut size={15} />
          </button>
          <button className="cp-icon-btn" title="Clear marks (G)" aria-label="Clear marks" onClick={onClearMarks}>
            <IconClearMarks size={15} />
          </button>
        </div>
        <button
          className={"cp-icon-btn snapshot" + (snapshotBusy ? " busy" : "")}
          title="Save frame at playhead as image"
          aria-label="Save frame as image"
          onClick={onSnapshot}
          disabled={snapshotBusy || !canSnapshot}
        >
          <IconCamera size={15} />
        </button>
        <div className="cp-icon-divider" />
        <SpeedControl rate={playbackRate} supported={playbackRateSupported} onRateChange={onPlaybackRateChange} />
        <VolumeControl
          volume={volume}
          muted={muted}
          onVolumeChange={onVolumeChange}
          onMutedChange={onMutedChange}
        />
        <button
          className={"cp-icon-btn cc" + (captionsOn ? " active" : "")}
          title={captionsOn ? "Hide captions" : "Turn on captions"}
          aria-label="Captions"
          aria-pressed={captionsOn}
          onClick={onToggleCaptions}
        >
          <IconCaptions size={15} />
        </button>
        <div className="cp-tc duration">{durationTc}</div>
      </div>
    </div>
  );
}
