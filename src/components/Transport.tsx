import {
  IconPlay, IconPause, IconSkipBack, IconSkipForward,
  IconMarkIn, IconMarkOut, IconClearMarks, IconCaptions, IconCamera,
} from "./Icons";
import type { ReactNode } from "react";
import { VolumeControl } from "./VolumeControl";
import { SpeedControl } from "./SpeedControl";
import { usePlayheadFrames } from "../lib/playhead-store";
import { framesToTc } from "../lib/timecode";
import type { AppStatus } from "../types";

/** Live playhead readout — the one part of the transport that ticks at up to
 *  60Hz, so it alone subscribes to the playhead store. The rest of the bar
 *  (buttons, volume, duration) renders only when its own props change. */
function PlayheadTc({ fps }: { fps: number }) {
  const frames = usePlayheadFrames();
  return <div className="cp-tc">{framesToTc(frames, fps)}</div>;
}

type Props = {
  liveInput?: string;
  liveController?: "premiere" | "presenter";
  status: AppStatus;
  isPlaying: boolean;
  fps: number;
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
  /** Room face: the session control cluster (mic/cam/share/theater/leave)
   *  rendered at the row's right edge, where controls belong. */
  roomControls?: ReactNode;
  sourceControls?: ReactNode;
};

export function Transport({
  status, isPlaying, liveInput, liveController = "presenter",
  fps, durationTc,
  captionsOn, snapshotBusy, canSnapshot,
  volume, muted, playbackRate, playbackRateSupported,
  onPlayToggle, onStep, onMarkIn, onMarkOut, onClearMarks, onToggleCaptions, onSnapshot,
  onVolumeChange, onMutedChange, onPlaybackRateChange, roomControls, sourceControls,
}: Props) {
  const live = !!liveInput;
  const liveReason = liveController === "premiere" ? "Playback controlled in Premiere" : "Playback controlled by the presenter";
  // In a room the row must stay interactive even with no source loaded
  // (a waiting guest still needs mic/cam/leave), so the dim gate lifts.
  const unavailable = status === "empty" || status === "fetching" || status === "error";
  const dim = unavailable && !roomControls && !live && !sourceControls;
  return (
    <div
      className={"cp-transport" + (live ? " cp-transport-live" : "")}
      role="region"
      aria-label="Playback transport"
      style={{ opacity: dim ? 0.5 : 1, pointerEvents: dim ? "none" : "auto" }}
    >
      {/* LEFT — current playhead */}
      <div className="cp-transport-side left">
        {live ? <span className="cp-source-status" title={`${liveInput} · ${liveReason}`}>Live</span> : <PlayheadTc fps={fps} />}
        {live && liveController === "premiere" && <div className="cp-source-timing">
          <span title="NDI picture timing has not been verified as Premiere sequence timecode. Notes remain general or manually timecoded; the companion currently supports editor-confirmed marker placement.">Timeline timecode unavailable</span>
          <span aria-hidden="true">·</span><span>{liveReason}</span>
        </div>}
      </div>

      {/* CENTER — primary playback controls, dead center */}
      <div className="cp-transport-center">
        {!live && <>
        <button className="cp-transport-btn" disabled={live || unavailable} title={live ? liveReason : "Step back 1 frame (←)"} aria-label="Step back one frame" onClick={() => onStep(-1)}>
          <IconSkipBack size={14} />
        </button>
        <button
          className={"cp-transport-btn play" + (isPlaying ? " active" : "")}
          title={live ? liveReason : "Play / pause (K, Space)"}
          disabled={live || unavailable}
          aria-label={!live && isPlaying ? "Pause" : "Play"}
          onClick={onPlayToggle}
        >
          {!live && isPlaying ? <IconPause size={16} /> : <IconPlay size={14} />}
        </button>
        <button className="cp-transport-btn" disabled={live || unavailable} title={live ? liveReason : "Step forward 1 frame (→)"} aria-label="Step forward one frame" onClick={() => onStep(1)}>
          <IconSkipForward size={14} />
        </button>
        </>}
      </div>

      {/* RIGHT — marks, captions, duration */}
      <div className="cp-transport-side right">
        <div className="cp-transport-media">
        {!live && <>
        <div className="cp-icon-group">
          <button className="cp-icon-btn" disabled={live} title={live ? liveReason : "Mark in (I)"} aria-label="Mark in" onClick={onMarkIn}>
            <IconMarkIn size={16} />
          </button>
          <button className="cp-icon-btn" disabled={live} title={live ? liveReason : "Mark out (O)"} aria-label="Mark out" onClick={onMarkOut}>
            <IconMarkOut size={16} />
          </button>
          <button className="cp-icon-btn" disabled={live} title={live ? liveReason : "Clear in/out (G)"} aria-label="Clear in/out" onClick={onClearMarks}>
            <IconClearMarks size={16} />
          </button>
        </div>
        <button
          className={"cp-icon-btn snapshot" + (snapshotBusy ? " busy" : "")}
          title="Save frame at playhead as image"
          aria-label="Save frame as image"
          onClick={onSnapshot}
          disabled={live || snapshotBusy || !canSnapshot}
        >
          <IconCamera size={15} />
        </button>
        <div className="cp-icon-divider" />
        <SpeedControl rate={live ? 1 : playbackRate} supported={!live && playbackRateSupported} disabledReason={live ? liveReason : undefined} onRateChange={onPlaybackRateChange} />
        </>}
        <VolumeControl
          volume={volume}
          muted={muted}
          onVolumeChange={onVolumeChange}
          onMutedChange={onMutedChange}
        />
        {sourceControls}
        {!live && <><button
          className={"cp-icon-btn cc" + (captionsOn ? " active" : "")}
          title={captionsOn ? "Hide captions" : "Turn on captions"}
          aria-label="Captions"
          aria-pressed={captionsOn}
          disabled={live}
          onClick={onToggleCaptions}
        >
          <IconCaptions size={15} />
        </button>
        <div className="cp-tc duration">{live ? "" : durationTc}</div>
        </>}
        </div>
        {roomControls}
      </div>
    </div>
  );
}
