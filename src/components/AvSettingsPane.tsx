import { useCallback, useEffect, useRef, useState } from "react";
import { CollapsibleSection } from "./CollapsibleSection";
import { useMediaCapture } from "../hooks/use-media-capture";
import { SPEAKER_OUTPUT_CHANGED_EVENT, canPickSpeakers, nativeAvStatus, type AvAuthState } from "../lib/media-devices";
import { IconMic, IconVideo } from "./Icons";
import { invoke } from "@tauri-apps/api/core";

/**
 * Settings > Camera & Mic - the Discord-style AV panel, scoped to what
 * WebKit actually honors (researched 2026-07-19): device pickers, live
 * preview, level meter, a record-and-play-back mic check, ONE voice
 * processing toggle (echoCancellation is the only processing constraint
 * WebKit implements; noise suppression and gain ride Apple's pipeline with
 * it), speakers via setSinkId where available (WebKit 18.4+), and join
 * defaults. All hardware access rides the capture singleton, so an open
 * session keeps its stream and picks up switches via replaceTrack.
 */
export function AvSettingsPane({ sectionOpen, toggleSection }: {
  sectionOpen: (id: string) => boolean;
  toggleSection: (id: string) => void;
}) {
  const cap = useMediaCapture();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const rafRef = useRef(0);
  // Release on close ONLY if this pane turned the hardware on (never steal
  // a live session's stream).
  const ownedHereRef = useRef(false);
  const hadStreamOnMount = useRef(cap.stream != null);
  useEffect(() => () => {
    if (ownedHereRef.current && !hadStreamOnMount.current) cap.release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const camLive = !!cap.stream && cap.stream.getVideoTracks().length > 0 && !cap.choice.cameraOff;

  // THE real macOS TCC state (WKWebView can't tell us). Drives the status
  // row + the "granted but relaunch needed" hint.
  const [tcc, setTcc] = useState<{ camera: AvAuthState; microphone: AvAuthState } | null>(null);
  const refreshTcc = useCallback(() => { void nativeAvStatus().then(setTcc); }, []);
  useEffect(() => { refreshTcc(); }, [refreshTcc, cap.permission]);

  // Auto-start the preview when authorized and nothing is live - the Camera
  // & Mic pane is where you EXPECT to see yourself (Zoom/Discord do this).
  // Once only; never steals a session's stream.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current || cap.stream) return;
    if (tcc?.camera === "authorized" || tcc?.microphone === "authorized") {
      autoStartedRef.current = true;
      ownedHereRef.current = true;
      void cap.acquire(cap.choice);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tcc]);

  const permLabel = (s: AvAuthState | undefined): string =>
    s === "authorized" ? "Allowed"
    : s === "denied" ? "Not allowed"
    : s === "restricted" ? "Restricted"
    : "Not asked yet";

  // Preview follows the owned stream. camLive is a dep because the <video>
  // REMOUNTS when the camera toggles off->on - same stream, fresh element,
  // and a stream-only effect would leave it black.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = cap.stream;
    if (cap.stream) v.play().catch(() => { /* autoplay */ });
  }, [cap.stream, camLive]);

  // Level meter (the green room's analyser pattern).
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

  // Mic check: record a short clip, hear it back (Discord's "Let's Check").
  const [micTest, setMicTest] = useState<"idle" | "recording" | "playing">("idle");
  const recRef = useRef<MediaRecorder | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const startMicTest = () => {
    const s = cap.stream;
    if (!s || s.getAudioTracks().length === 0 || micTest !== "idle") return;
    try {
      const rec = new MediaRecorder(new MediaStream(s.getAudioTracks()));
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType }));
        const audio = new Audio(url);
        testAudioRef.current = audio;
        // Play back through the chosen speakers - the point of the test is
        // hearing what the room hears, on the output the room will use.
        const sink = cap.choice.speakerId;
        if (sink && canPickSpeakers()) {
          void (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(sink).catch(() => {});
        }
        const done = () => { URL.revokeObjectURL(url); testAudioRef.current = null; setMicTest("idle"); };
        setMicTest("playing");
        audio.onended = done;
        audio.play().catch(done);
      };
      recRef.current = rec;
      rec.start();
      setMicTest("recording");
      window.setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, 4000);
    } catch {
      setMicTest("idle");
    }
  };
  useEffect(() => () => {
    try { recRef.current?.stop(); } catch { /* inactive */ }
    // No ghost audio after the pane closes.
    testAudioRef.current?.pause();
    testAudioRef.current = null;
  }, []);

  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;
  const acquire = (patch: Partial<typeof cap.choice>) => {
    ownedHereRef.current = true;
    void cap.acquire({ ...cap.choice, ...patch });
  };
  const pickSpeaker = (id: string | null) => {
    cap.updateChoice({ speakerId: id });
    try { window.dispatchEvent(new Event(SPEAKER_OUTPUT_CHANGED_EVENT)); } catch { /* non-DOM */ }
  };
  return (
    <section>
      <h3 className="cp-pane-title">Camera &amp; Mic</h3>
      <p className="cp-pane-sub">
        Devices for review sessions. Everything runs on this Mac; switching devices
        mid-session carries over to the room without reconnecting.
      </p>

      <CollapsibleSection id="av-devices" label="Devices" open={sectionOpen("av-devices")} onToggle={() => toggleSection("av-devices")}>
        {/* Permission status - the real macOS TCC answer, per device. */}
        <div className="cp-pane-row">
          <div className="k">
            Permissions
            <span className="desc">Controlled in macOS System Settings - Privacy &amp; Security.</span>
          </div>
          <div className="v cp-av-perms">
            <span className={"cp-av-perm " + (tcc?.camera ?? "notDetermined")}>
              <IconVideo size={12} /> {permLabel(tcc?.camera)}
            </span>
            <span className={"cp-av-perm " + (tcc?.microphone ?? "notDetermined")}>
              <IconMic size={12} /> {permLabel(tcc?.microphone)}
            </span>
          </div>
        </div>
        {(tcc?.camera === "denied" || tcc?.microphone === "denied" || tcc?.camera === "restricted" || tcc?.microphone === "restricted") && (
          <div className="cp-pane-row">
            <div className="k">
              Blocked
              <span className="desc">Allow Camera and Microphone for Sauce Bunny in System Settings, then quit and reopen the app - macOS applies the change on relaunch.</span>
            </div>
            <div className="v">
              <button type="button" className="btn btn-ghost btn-compact"
                onClick={() => { void invoke("open_privacy_pane", { anchor: "Privacy_Camera" }).catch(() => {}); }}>
                Open System Settings
              </button>
            </div>
          </div>
        )}
        {/* Authorized but no live stream: auto-start pending, or capture
            failed despite the grant (the relaunch quirk). */}
        {!cap.stream && (tcc?.camera === "authorized" || tcc?.microphone === "authorized") && (
          <div className="cp-pane-row">
            <div className="k">
              Preview
              <span className="desc">
                {cap.error
                  ? "Allowed, but the camera didn't start. If you just granted access, quit and reopen the app - macOS applies it on relaunch."
                  : "Starting the camera so you can pick devices and see yourself…"}
              </span>
            </div>
            <div className="v">
              <button type="button" className="btn btn-ghost btn-compact" onClick={() => { refreshTcc(); acquire({}); }}>
                {cap.error ? "Try again" : "Start now"}
              </button>
            </div>
          </div>
        )}
        {/* Never asked: the enable button triggers the OS prompt. */}
        {!cap.stream && tcc?.camera === "notDetermined" && tcc?.microphone === "notDetermined" && (
          <div className="cp-pane-row">
            <div className="k">
              Preview
              <span className="desc">Enable the camera and microphone to pick devices and see yourself.</span>
            </div>
            <div className="v">
              <button type="button" className="btn cp-colobby-cta" onClick={() => { autoStartedRef.current = true; acquire({}); }}>
                <IconVideo size={13} /><IconMic size={13} /> Enable camera and mic
              </button>
            </div>
          </div>
        )}
        {cap.stream && (
          <>
            <div className="cp-pane-row">
              <div className="k">
                Preview
                <span className="desc">Mirrored, like every conferencing self-view.</span>
              </div>
              <div className="v">
                <div className="cp-av-preview">
                  {camLive
                    ? <video ref={videoRef} muted playsInline aria-label="Camera preview" />
                    : <span className="cp-av-preview-off">Camera off</span>}
                </div>
              </div>
            </div>
            <div className="cp-pane-row">
              <div className="k"><IconVideo size={12} /> Camera</div>
              <div className="v">
                <select
                  className="cp-select"
                  value={cap.choice.cameraId ?? ""}
                  onChange={(e) => acquire({ cameraId: e.target.value || null })}
                >
                  {cap.devices.cameras.length === 0 && <option value="">Default</option>}
                  {cap.devices.cameras.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>{label(d, i, "Camera")}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="cp-pane-row">
              <div className="k"><IconMic size={12} /> Microphone</div>
              <div className="v">
                <select
                  className="cp-select"
                  value={cap.choice.micId ?? ""}
                  onChange={(e) => acquire({ micId: e.target.value || null })}
                >
                  {cap.devices.mics.length === 0 && <option value="">Default</option>}
                  {cap.devices.mics.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>{label(d, i, "Microphone")}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="cp-pane-row">
              <div className="k">
                Input level
                <span className="desc">Speak normally; the bars should move well before the end.</span>
              </div>
              <div className="v">
                <div className="cp-gr-meter" aria-label="Microphone level" role="img">
                  {Array.from({ length: 12 }, (_, i) => (
                    <span key={i} ref={(el) => { barsRef.current[i] = el; }} className="cp-gr-meter-bar" />
                  ))}
                </div>
              </div>
            </div>
            {canPickSpeakers() && cap.devices.speakers.length > 0 && (
              <div className="cp-pane-row">
                <div className="k">
                  Speakers
                  <span className="desc">Where session voices play. System default unless changed.</span>
                </div>
                <div className="v">
                  <select
                    className="cp-select"
                    value={cap.choice.speakerId ?? ""}
                    onChange={(e) => pickSpeaker(e.target.value || null)}
                  >
                    <option value="">System default</option>
                    {cap.devices.speakers.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>{label(d, i, "Speakers")}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </>
        )}
        {cap.error && <p className="cp-colobby-err" role="alert">{cap.error}</p>}
      </CollapsibleSection>

      <CollapsibleSection id="av-voice" label="Voice processing" open={sectionOpen("av-voice")} onToggle={() => toggleSection("av-voice")}>
        <div className="cp-pane-row">
          <div className="k">
            Voice processing
            <span className="desc">Echo cancellation through the macOS voice pipeline, which also reduces background noise and levels your mic. Turn off to send the raw microphone (music, instruments).</span>
          </div>
          <div className="v">
            <button
              className={"cp-toggle-switch" + (cap.choice.echoCancel ? " on" : "")}
              aria-label="Voice processing"
              aria-pressed={cap.choice.echoCancel}
              onClick={() => {
                const next = { ...cap.choice, echoCancel: !cap.choice.echoCancel };
                if (cap.stream) { ownedHereRef.current = true; void cap.acquire(next); }
                else cap.updateChoice({ echoCancel: next.echoCancel });
              }}
            />
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Mic check
            <span className="desc">Records four seconds and plays it back so you hear what the room hears.</span>
          </div>
          <div className="v">
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              disabled={!cap.stream || micTest !== "idle"}
              onClick={startMicTest}
            >
              {micTest === "recording" ? "Recording…" : micTest === "playing" ? "Playing…" : "Record a test"}
            </button>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="av-join" label="Joining sessions" open={sectionOpen("av-join")} onToggle={() => toggleSection("av-join")}>
        <div className="cp-pane-row">
          <div className="k">
            Join with camera off
            <span className="desc">Presence shows your avatar until you turn the camera on.</span>
          </div>
          <div className="v">
            <button
              className={"cp-toggle-switch" + (cap.choice.cameraOff ? " on" : "")}
              aria-label="Join with camera off"
              aria-pressed={cap.choice.cameraOff}
              onClick={() => cap.setEnabled("video", cap.choice.cameraOff)}
            />
          </div>
        </div>
        <div className="cp-pane-row">
          <div className="k">
            Join muted
            <span className="desc">Your mic starts muted in every session.</span>
          </div>
          <div className="v">
            <button
              className={"cp-toggle-switch" + (cap.choice.micMuted ? " on" : "")}
              aria-label="Join muted"
              aria-pressed={cap.choice.micMuted}
              onClick={() => cap.setEnabled("audio", cap.choice.micMuted)}
            />
          </div>
        </div>
      </CollapsibleSection>
    </section>
  );
}
