import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconChevronRight, IconMic, IconMicOff, IconVideo, IconVideoOff } from "./Icons";
import { nativeAvStatus, type AvAuthState } from "../lib/media-devices";
import { METER_SEGMENTS, meterZoneClass, startLevelMeter } from "../lib/level-meter";
import type { useMediaCapture } from "../hooks/use-media-capture";
import { DeviceSelect } from "./DeviceSelect";

/**
 * The green room's DEVICES step (sibling of CoReviewLobby, which owns the
 * step flow). Meet-style: the 16:9 preview surface is ALWAYS there - before
 * enabling it hosts the camera-off placeholder and the enable action, after
 * enabling it shows you; denied renders its recovery inside the same frame.
 * No green anywhere: every action is the grey chip. All hardware access
 * rides the useMediaCapture ownership hook - this component never touches
 * navigator.mediaDevices itself.
 */
export function GreenRoomDevices({ cap, onContinue }: {
  cap: ReturnType<typeof useMediaCapture>;
  onContinue: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const camLive = !!cap.stream && cap.stream.getVideoTracks().length > 0 && !cap.choice.cameraOff;

  // ── Already granted? Then start, and do not ask again ─────────────────
  //
  // Settings ▸ Camera & Mic has auto-started the preview when TCC says
  // authorized since it was written - the pane where you expect to see
  // yourself. This step did not, so a user who had already granted access,
  // and could see themselves in Settings, arrived here to "Your camera is off
  // until you enable it" and a button captioned "Enable camera and mic". Both
  // read as a permission request for permission they had already given.
  //
  // The grant is the decision. Acquiring is just acting on it, and macOS
  // shows no prompt when the answer is already recorded.
  const [tcc, setTcc] = useState<{ camera: AvAuthState; microphone: AvAuthState } | null>(null);
  useEffect(() => { void nativeAvStatus().then((s) => setTcc(s ? { camera: s.camera, microphone: s.microphone } : null)); }, []);
  const granted = tcc?.camera === "authorized" || tcc?.microphone === "authorized";

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current || cap.stream || !granted) return;
    // Respect a deliberate "join with camera off": acquire still gives us the
    // mic and the level meter, and cameraOff keeps the video track dark, so
    // this never overrides that choice.
    autoStartedRef.current = true;
    void cap.acquire(cap.choice);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the grant
  }, [granted]);

  // Preview follows the owned stream. camLive is a dep: the <video>
  // remounts when the camera toggles off->on (same stream, fresh element).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = cap.stream;
    if (cap.stream) v.play().catch(() => { /* autoplay policies */ });
  }, [cap.stream, camLive]);

  // Live mic level - shared driver (src/lib/level-meter.ts): horizontal
  // green/yellow/red strip with peak hold, suspended-AudioContext safe.
  useEffect(() => {
    const s = cap.stream;
    if (!s) return;
    return startLevelMeter(s, () => barsRef.current);
  }, [cap.stream]);

  // The opener plugin's default scope blocks x-apple.systempreferences:
  // links (the old deep link silently no-oped) - macOS `open` via Rust is
  // the app's proven path. Ask TCC which device is actually blocked so a
  // mic-only denial deep-links to the Microphone pane, not Camera.
  const openPrivacySettings = () => {
    void nativeAvStatus().then((s) => {
      const anchor = s && s.camera === "authorized" && s.microphone !== "authorized"
        ? "Privacy_Microphone"
        : "Privacy_Camera";
      void invoke("open_privacy_pane", { anchor }).catch(() => { /* surfaced in logs */ });
    });
  };

  return (
    <section className="cp-colobby-card cp-gr-devices" aria-label="Camera and microphone">
      <h2 className="cp-colobby-card-title">Camera and mic</h2>

      {/* THE preview surface - every state renders inside this one frame. */}
      <div className="cp-gr-preview">
        {camLive && <video ref={videoRef} muted playsInline aria-label="Camera preview" />}
        {cap.permission === "denied" ? (
          <div className="cp-gr-preview-state">
            <IconVideoOff size={26} />
            <p className="cp-gr-state-line">Camera and microphone are blocked for Sauce Bunny.</p>
            <p className="cp-gr-state-sub">After allowing them in System Settings, quit and reopen the app. macOS requires it.</p>
            <div className="cp-gr-denied-row">
              <button type="button" className="btn btn-ghost btn-compact" onClick={openPrivacySettings}>
                Open System Settings
              </button>
              <button type="button" className="btn btn-ghost btn-compact" onClick={() => { void cap.acquire(cap.choice); }}>
                Try again
              </button>
            </div>
          </div>
        ) : !cap.stream ? (
          <div className="cp-gr-preview-state">
            <IconVideoOff size={26} />
            {/* The copy follows the PERMISSION, not the stream. "Enable camera
                and mic" is a request for access; once access is granted the
                only thing left to do is turn the camera on, and saying
                otherwise implies the earlier grant did not take. */}
            <p className="cp-gr-state-line">
              {granted ? "Starting your camera…" : "Your camera is off until you enable it."}
            </p>
            <button type="button" className="btn cp-colobby-cta" onClick={() => { void cap.acquire(cap.choice); }}>
              <IconVideo size={14} /><IconMic size={14} /> {granted ? "Turn on camera and mic" : "Enable camera and mic"}
            </button>
          </div>
        ) : !camLive ? (
          <div className="cp-gr-preview-state">
            <IconVideoOff size={26} />
            <p className="cp-gr-state-line">Camera off</p>
          </div>
        ) : null}
      </div>

      {cap.stream && (
        <>
          <div className="cp-gr-meter" aria-label="Microphone level" role="img">
            {Array.from({ length: METER_SEGMENTS }, (_, i) => (
              <span key={i} ref={(el) => { barsRef.current[i] = el; }} className={meterZoneClass(i)} />
            ))}
          </div>
          <div className="cp-gr-selects">
            <DeviceSelect
              kind="camera"
              devices={cap.devices.cameras}
              value={cap.choice.cameraId}
              onPick={(id) => { void cap.acquire({ ...cap.choice, cameraId: id }); }}
            />
            <DeviceSelect
              kind="microphone"
              devices={cap.devices.mics}
              value={cap.choice.micId}
              onPick={(id) => { void cap.acquire({ ...cap.choice, micId: id }); }}
            />
          </div>
          <div className="cp-gr-toggles">
            <button
              type="button"
              className={"btn btn-ghost btn-compact" + (cap.choice.cameraOff ? " active" : "")}
              aria-pressed={cap.choice.cameraOff}
              onClick={() => cap.setEnabled("video", cap.choice.cameraOff)}
            >
              {cap.choice.cameraOff ? <IconVideoOff size={12} /> : <IconVideo size={12} />}
              {cap.choice.cameraOff ? " Camera off" : " Camera on"}
            </button>
            <button
              type="button"
              className={"btn btn-ghost btn-compact" + (cap.choice.micMuted ? " active" : "")}
              aria-pressed={cap.choice.micMuted}
              onClick={() => cap.setEnabled("audio", cap.choice.micMuted)}
            >
              {cap.choice.micMuted ? <IconMicOff size={12} /> : <IconMic size={12} />}
              {cap.choice.micMuted ? " Mic muted" : " Mic on"}
            </button>
          </div>
        </>
      )}

      {cap.error && <p className="cp-colobby-err" role="alert">{cap.error}</p>}

      <div className="cp-gr-devices-foot">
        <button type="button" className="btn cp-colobby-cta" onClick={onContinue}>
          Continue <IconChevronRight size={12} />
        </button>
        {!cap.stream && cap.permission !== "granted" && (
          <p className="cp-colobby-hint">You can join without devices. Presence shows your avatar.</p>
        )}
      </div>
    </section>
  );
}
