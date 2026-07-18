import { useState } from "react";
import {
  IconFullscreen, IconFullscreenExit, IconMic, IconMicOff,
  IconScreenShare, IconSettings, IconVideo, IconVideoOff,
} from "./Icons";
import { DevicePanel } from "./DevicePanel";
import { SharePicker } from "./SharePicker";
import type { ShareState } from "../lib/share-machine";

/**
 * The session room's control cluster: mic, camera, share screen (native
 * ffmpeg display capture; SharePicker owns the TCC dance), device settings,
 * theater, leave/end. Terse - labels are hover titles only. It renders
 * INSIDE the transport row's right side (Transport's roomControls slot),
 * with the snapshot/speed/volume controls - not floating over the timeline.
 */
export function RoomControlBar({ micOn, camOn, onToggleMic, onToggleCam, shareState, onStartShare, onStopShare, theater, onToggleTheater, onLeave, isHost }: {
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  shareState: ShareState;
  onStartShare: (displayIndex: number) => void;
  onStopShare: () => void;
  theater: boolean;
  onToggleTheater: () => void;
  onLeave: () => void;
  isHost: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
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
        {camOn ? <IconVideo size={16} /> : <IconVideoOff size={16} />}
      </button>
      <button
        type="button"
        className={"cp-room-bar-btn" + (shareState === "sharing" ? " active" : "")}
        title={shareState === "sharing" ? "Stop sharing" : "Share screen"}
        aria-label={shareState === "sharing" ? "Stop sharing your screen" : "Share your screen"}
        aria-pressed={shareState === "sharing"}
        disabled={shareState === "starting"}
        onClick={() => {
          if (shareState === "sharing") onStopShare();
          else { setDevicesOpen(false); setPickerOpen((v) => !v); }
        }}
      >
        <IconScreenShare size={16} />
      </button>
      {pickerOpen && shareState === "idle" && (
        <SharePicker
          onPick={onStartShare}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <button
        type="button"
        className={"cp-room-bar-btn" + (devicesOpen ? " active" : "")}
        title="Camera and mic settings"
        aria-label="Camera and microphone settings"
        aria-pressed={devicesOpen}
        onClick={() => { setPickerOpen(false); setDevicesOpen((v) => !v); }}
      >
        <IconSettings size={15} />
      </button>
      {devicesOpen && <DevicePanel onClose={() => setDevicesOpen(false)} />}
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
