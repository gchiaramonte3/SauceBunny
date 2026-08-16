import { useEffect, useRef } from "react";
import { useMediaCapture } from "../hooks/use-media-capture";
import { DeviceSelect } from "./DeviceSelect";

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

  const camLive = !!cap.stream && cap.stream.getVideoTracks().length > 0 && !cap.choice.cameraOff;

  // camLive is a dep: the <video> remounts when the camera toggles off->on
  // (same stream, fresh element) and needs its srcObject re-attached.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = cap.stream;
    if (cap.stream) v.play().catch(() => { /* autoplay */ });
  }, [cap.stream, camLive]);

  return (
    <div className="cp-devpanel" role="dialog" aria-label="Camera and microphone settings">
      <div className="cp-devpanel-preview">
        {camLive
          ? <video ref={videoRef} muted playsInline aria-hidden />
          : <span className="cp-devpanel-off">Camera off</span>}
      </div>
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
      {cap.error && <p className="cp-colobby-err" role="alert">{cap.error}</p>}
      <button type="button" className="btn btn-ghost btn-compact cp-devpanel-done" onClick={onClose}>
        Done
      </button>
    </div>
  );
}
