import {
  IconCamera, IconCameraOff, IconFullscreen, IconFullscreenExit,
  IconMic, IconMicOff, IconScreenShare,
} from "./Icons";

/**
 * The session room's floating control bar (bottom-center): mic, camera,
 * share screen (disabled until the native pipeline lands next build),
 * theater, leave/end. Terse - labels are hover titles only. The bar rests
 * dimmed and wakes on hover/focus (reduced motion: always full).
 */
export function RoomControlBar({ micOn, camOn, onToggleMic, onToggleCam, theater, onToggleTheater, onLeave, isHost }: {
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  theater: boolean;
  onToggleTheater: () => void;
  onLeave: () => void;
  isHost: boolean;
}) {
  return (
    <div className="cp-room-bar" role="toolbar" aria-label="Room controls">
      <button
        type="button"
        className={"cp-room-bar-btn" + (micOn ? "" : " off")}
        title={micOn ? "Mute mic" : "Unmute mic"}
        aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
        aria-pressed={!micOn}
        onClick={onToggleMic}
      >
        {micOn ? <IconMic size={16} /> : <IconMicOff size={16} />}
      </button>
      <button
        type="button"
        className={"cp-room-bar-btn" + (camOn ? "" : " off")}
        title={camOn ? "Turn camera off" : "Turn camera on"}
        aria-label={camOn ? "Turn camera off" : "Turn camera on"}
        aria-pressed={!camOn}
        onClick={onToggleCam}
      >
        {camOn ? <IconCamera size={16} /> : <IconCameraOff size={16} />}
      </button>
      <button
        type="button"
        className="cp-room-bar-btn"
        title="Screen share arrives with the next build"
        aria-label="Share screen (coming soon)"
        disabled
      >
        <IconScreenShare size={16} />
      </button>
      <span className="cp-room-bar-sep" aria-hidden />
      <button
        type="button"
        className={"cp-room-bar-btn" + (theater ? " active" : "")}
        title={theater ? "Exit theater" : "Theater"}
        aria-label={theater ? "Exit theater" : "Theater: widen the stage"}
        aria-pressed={theater}
        onClick={onToggleTheater}
      >
        {theater ? <IconFullscreenExit size={16} /> : <IconFullscreen size={16} />}
      </button>
      <button
        type="button"
        className="cp-room-bar-btn leave"
        title={isHost ? "End session" : "Leave session"}
        aria-label={isHost ? "End the session" : "Leave the session"}
        onClick={onLeave}
      >
        {isHost ? "End" : "Leave"}
      </button>
    </div>
  );
}
