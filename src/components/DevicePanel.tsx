import { useEffect, useRef } from "react";
import { useMediaCapture } from "../hooks/use-media-capture";
import { IconMic, IconVideo } from "./Icons";

/**
 * In-session device settings popover (the room cluster's gear) - the
 * Meet-style mid-call switcher: live preview plus camera/mic selects.
 * Every switch rides useMediaCapture's singleton, which fans the new
 * stream out to the self tile and to every peer via replaceTrack, so
 * changing devices mid-call needs no renegotiation and no rejoin.
 */
export function DevicePanel({ onClose }: { onClose: () => void }) {
  const cap = useMediaCapture();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const refreshedRef = useRef(false);

  // Hot-plugged devices appear when the panel opens (once per mount).
  useEffect(() => {
    if (refreshedRef.current) return;
    refreshedRef.current = true;
    void cap.refreshDevices();
  }, [cap]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = cap.stream;
    if (cap.stream) v.play().catch(() => { /* autoplay */ });
  }, [cap.stream]);

  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;
  const camLive = !!cap.stream && cap.stream.getVideoTracks().length > 0 && !cap.choice.cameraOff;

  return (
    <div className="cp-devpanel" role="dialog" aria-label="Camera and microphone settings">
      <div className="cp-devpanel-preview">
        {camLive
          ? <video ref={videoRef} muted playsInline aria-hidden />
          : <span className="cp-devpanel-off">Camera off</span>}
      </div>
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
      {cap.error && <p className="cp-colobby-err" role="alert">{cap.error}</p>}
      <button type="button" className="btn btn-ghost btn-compact cp-devpanel-done" onClick={onClose}>
        Done
      </button>
    </div>
  );
}
