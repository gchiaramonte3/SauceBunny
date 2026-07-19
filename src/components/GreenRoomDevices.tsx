import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconChevronRight, IconMic, IconMicOff, IconVideo, IconVideoOff } from "./Icons";
import type { useMediaCapture } from "../hooks/use-media-capture";

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
  const rafRef = useRef(0);
  const camLive = !!cap.stream && cap.stream.getVideoTracks().length > 0 && !cap.choice.cameraOff;

  // Preview follows the owned stream. camLive is a dep: the <video>
  // remounts when the camera toggles off->on (same stream, fresh element).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = cap.stream;
    if (cap.stream) v.play().catch(() => { /* autoplay policies */ });
  }, [cap.stream, camLive]);

  // Live mic level: AnalyserNode driving 12 bars (DictationWave's DOM-bar
  // pattern). Reduced motion renders the static bars, no rAF.
  useEffect(() => {
    const s = cap.stream;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!s || s.getAudioTracks().length === 0 || reduced) return;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(s);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
      const level = Math.min(1, peak / 96);
      barsRef.current.forEach((b, i) => {
        if (!b) return;
        const t = (i + 1) / barsRef.current.length;
        b.style.transform = `scaleY(${level >= t * 0.9 ? 1 : 0.25})`;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      src.disconnect();
      void ctx.close();
    };
  }, [cap.stream]);

  // The opener plugin's default scope blocks x-apple.systempreferences:
  // links (the old deep link silently no-oped) - macOS `open` via Rust is
  // the app's proven path.
  const openPrivacySettings = () => {
    void invoke("open_privacy_pane", { anchor: "Privacy_Camera" }).catch(() => { /* surfaced in logs */ });
  };
  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;

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
            <p className="cp-gr-state-line">Your camera is off until you enable it.</p>
            <button type="button" className="btn cp-colobby-cta" onClick={() => { void cap.acquire(cap.choice); }}>
              <IconVideo size={14} /><IconMic size={14} /> Enable camera and mic
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
            {Array.from({ length: 12 }, (_, i) => (
              <span key={i} ref={(el) => { barsRef.current[i] = el; }} className="cp-gr-meter-bar" />
            ))}
          </div>
          <div className="cp-gr-selects">
            <label className="cp-colobby-field">
              <span className="cp-colobby-field-label"><IconVideo size={12} /> Camera</span>
              <select
                className="cp-colobby-input"
                value={cap.choice.cameraId ?? ""}
                onChange={(e) => { void cap.acquire({ ...cap.choice, cameraId: e.target.value || null }); }}
              >
                {cap.devices.cameras.length === 0 && <option value="">Default</option>}
                {cap.devices.cameras.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{label(d, i, "Camera")}</option>
                ))}
              </select>
            </label>
            <label className="cp-colobby-field">
              <span className="cp-colobby-field-label"><IconMic size={12} /> Microphone</span>
              <select
                className="cp-colobby-input"
                value={cap.choice.micId ?? ""}
                onChange={(e) => { void cap.acquire({ ...cap.choice, micId: e.target.value || null }); }}
              >
                {cap.devices.mics.length === 0 && <option value="">Default</option>}
                {cap.devices.mics.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{label(d, i, "Microphone")}</option>
                ))}
              </select>
            </label>
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
