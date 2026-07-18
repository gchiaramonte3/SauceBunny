import { useEffect, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { useMediaCapture } from "../hooks/use-media-capture";

/**
 * The green room's DEVICES step (sibling of CoReviewLobby, which owns the
 * step flow): camera preview, device selects, live mic meter, permission
 * states. All hardware access rides the useMediaCapture ownership hook -
 * this component never touches navigator.mediaDevices itself.
 */
export function GreenRoomDevices({ cap, onContinue }: {
  cap: ReturnType<typeof useMediaCapture>;
  onContinue: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const rafRef = useRef(0);

  // Preview follows the owned stream.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = cap.stream;
    if (cap.stream) v.play().catch(() => { /* autoplay policies */ });
  }, [cap.stream]);

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

  const openPrivacySettings = () => {
    void openUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera").catch(() => { /* opener denied */ });
  };
  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;

  return (
    <section className="cp-colobby-card cp-gr-devices" aria-label="Camera and microphone">
      <h2 className="cp-colobby-card-title">Camera and mic</h2>

      {cap.permission === "denied" ? (
        <div className="cp-gr-denied">
          <p>Camera and microphone are blocked for Sauce Bunny.</p>
          <div className="cp-gr-denied-row">
            <button type="button" className="btn btn-ghost btn-compact" onClick={openPrivacySettings}>
              Open System Settings
            </button>
            <button type="button" className="btn btn-ghost btn-compact" onClick={() => { void cap.acquire(cap.choice); }}>
              Try again
            </button>
          </div>
        </div>
      ) : cap.stream ? (
        <>
          <div className="cp-gr-preview">
            <video ref={videoRef} muted playsInline aria-label="Camera preview" />
            {cap.choice.cameraOff && <div className="cp-gr-preview-off">Camera off</div>}
          </div>
          <div className="cp-gr-meter" aria-label="Microphone level" role="img">
            {Array.from({ length: 12 }, (_, i) => (
              <span key={i} ref={(el) => { barsRef.current[i] = el; }} className="cp-gr-meter-bar" />
            ))}
          </div>
          <div className="cp-gr-selects">
            <label className="cp-colobby-field">
              <span className="cp-colobby-field-label">Camera</span>
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
              <span className="cp-colobby-field-label">Microphone</span>
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
              {cap.choice.cameraOff ? "Camera off" : "Camera on"}
            </button>
            <button
              type="button"
              className={"btn btn-ghost btn-compact" + (cap.choice.micMuted ? " active" : "")}
              aria-pressed={cap.choice.micMuted}
              onClick={() => cap.setEnabled("audio", cap.choice.micMuted)}
            >
              {cap.choice.micMuted ? "Mic muted" : "Mic on"}
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn btn-primary cp-colobby-cta" onClick={() => { void cap.acquire(cap.choice); }}>
          Enable camera and microphone
        </button>
      )}

      {cap.error && <p className="cp-colobby-err" role="alert">{cap.error}</p>}

      <div className="cp-gr-devices-foot">
        {/* P7 one-green-per-face: pre-grant, "Enable camera and microphone"
            is the face's primary - Continue stays quiet until a stream
            exists (or the user is skipping devices entirely). */}
        <button type="button"
          className={"btn " + (cap.stream || cap.permission === "denied" ? "btn-primary" : "btn-ghost") + " cp-colobby-cta"}
          onClick={onContinue}>
          Continue
        </button>
        {!cap.stream && cap.permission !== "granted" && (
          <p className="cp-colobby-hint">You can join without devices. Presence shows your avatar.</p>
        )}
      </div>
    </section>
  );
}
