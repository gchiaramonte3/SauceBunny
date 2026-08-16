import type { ShareSourceArg } from "../bindings/ShareSourceArg";
import { useState } from "react";
import {
  IconFullscreen, IconFullscreenExit, IconMic, IconMicOff,
  IconScreenShare, IconSettings, IconSmile, IconVideo, IconVideoOff,
} from "./Icons";
import { DevicePanel } from "./DevicePanel";
import { ReactionPicker } from "./ReactionPicker";
import { ShareDialog } from "./ShareDialog";
import type { ShareState } from "../lib/share-machine";

/**
 * The session room's control cluster: mic, camera, share screen (native
 * ScreenCaptureKit engine; ShareDialog owns the picker + TCC), devices,
 * theater. End/Leave lives in the room header, next to Copy join code.
 * Terse - labels are hover titles only. It renders
 * INSIDE the transport row's right side (Transport's roomControls slot),
 * with the snapshot/speed/volume controls - not floating over the timeline.
 */
export function RoomControlBar({ micOn, camOn, onToggleMic, onToggleCam, shareState, onStartShare, onStopShare, theater, onToggleTheater, onReact, handRaised, onToggleHand }: {
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  shareState: ShareState;
  onStartShare: (source: ShareSourceArg) => void;
  onStopShare: () => void;
  theater: boolean;
  onToggleTheater: () => void;
  onReact: (emote: string) => void;
  handRaised: boolean;
  onToggleHand: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  return (
    <div className="cp-room-bar" role="toolbar" aria-label="Room controls">
      <button
        type="button"
        className={"cp-room-bar-btn" + (micOn ? "" : " off")}
        title={micOn ? "Mute mic" : "Unmute mic"}
        aria-label={micOn ? "Mute microphone" : "Unmute microphone"}
        onClick={onToggleMic}
      >
        {micOn ? <IconMic size={15} /> : <IconMicOff size={15} />}
      </button>
      <button
        type="button"
        className={"cp-room-bar-btn" + (camOn ? "" : " off")}
        title={camOn ? "Turn camera off" : "Turn camera on"}
        aria-label={camOn ? "Turn camera off" : "Turn camera on"}
        onClick={onToggleCam}
      >
        {camOn ? <IconVideo size={15} /> : <IconVideoOff size={15} />}
      </button>
      <button
        type="button"
        className={"cp-room-bar-btn" + (shareState === "sharing" ? " active" : "")}
        /* The promise, stated: a share is live pixels, not the review
           subject. Watch-together (the source bar) keeps timecode. */
        title={shareState === "sharing" ? "Stop sharing" : "Share my screen. Shows your app live; no scrubbing, no timecode."}
        aria-label={shareState === "sharing" ? "Stop sharing your screen" : "Share your screen. Shows your app live with no scrubbing and no timecode."}
        aria-pressed={shareState === "sharing"}
        disabled={shareState === "starting"}
        onClick={() => {
          if (shareState === "sharing") onStopShare();
          else { setDevicesOpen(false); setPickerOpen((v) => !v); }
        }}
      >
        <IconScreenShare size={15} />
      </button>
      {pickerOpen && shareState === "idle" && (
        <ShareDialog
          onPick={onStartShare}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <button
        type="button"
        className={"cp-room-bar-btn" + (reactionsOpen || handRaised ? " active" : "")}
        title={handRaised ? "Reactions (hand raised)" : "Reactions"}
        aria-label="Send a reaction"
        onClick={() => { setPickerOpen(false); setDevicesOpen(false); setReactionsOpen((v) => !v); }}
      >
        <IconSmile size={15} />
      </button>
      {reactionsOpen && (
        <ReactionPicker
          onReact={onReact}
          handRaised={handRaised}
          onToggleHand={onToggleHand}
          onClose={() => setReactionsOpen(false)}
        />
      )}
      <button
        type="button"
        className={"cp-room-bar-btn" + (devicesOpen ? " active" : "")}
        title="Camera and microphone settings"
        aria-label="Camera and microphone settings"
        aria-pressed={devicesOpen}
        onClick={() => { setPickerOpen(false); setReactionsOpen(false); setDevicesOpen((v) => !v); }}
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
        {theater ? <IconFullscreenExit size={15} /> : <IconFullscreen size={15} />}
      </button>
    </div>
  );
}
