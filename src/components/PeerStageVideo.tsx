import { useEffect, useRef, useState } from "react";
import type { ProgramDiagnostics } from "../lib/program-diagnostics";

/** The explicitly selected presenter's program feed. Conversation stays separate. */
export function PeerStageVideo({ stream, who, ownerId, readDiagnostics, isSelf = false }: {
  stream: MediaStream;
  who: string;
  ownerId?: string;
  readDiagnostics?: (id: string) => Promise<ProgramDiagnostics | null>;
  /** The outgoing screen is monitored silently, never looped to the speakers. */
  isSelf?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const [volume, setVolume] = useState(1);
  const [stale, setStale] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<ProgramDiagnostics | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let lastFrame = performance.now();
    let frameId = 0;
    const frame = () => {
      lastFrame = performance.now();
      if (!disposed) frameId = el.requestVideoFrameCallback(frame);
    };
    const activity = () => { lastFrame = performance.now(); };
    el.srcObject = stream;
    // Before play(), including when a remote feed is replaced by our own.
    // This changes only this monitor element, not the outgoing audio track.
    el.muted = isSelf || mutedRef.current;
    setBlocked(false);
    void el.play().catch(() => { if (!disposed) setBlocked(true); });
    if (el.requestVideoFrameCallback) frameId = el.requestVideoFrameCallback(frame);
    else el.addEventListener("timeupdate", activity);
    const timer = window.setInterval(() => {
      const track = stream.getVideoTracks()[0];
      setStale(!track || track.readyState === "ended" || track.muted || performance.now() - lastFrame > 2000);
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (frameId) el.cancelVideoFrameCallback(frameId);
      el.removeEventListener("timeupdate", activity);
      el.srcObject = null;
    };
  }, [stream, isSelf]);

  useEffect(() => {
    if (ref.current) { ref.current.muted = isSelf || muted; ref.current.volume = volume; }
  }, [muted, volume, stream, isSelf]);

  useEffect(() => {
    if (!showStats || !ownerId || !readDiagnostics) return;
    let disposed = false;
    let pending = false;
    const sample = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await readDiagnostics(ownerId);
        if (!disposed) setStats(next);
      } catch { if (!disposed) setStats(null); }
      finally { pending = false; }
    };
    void sample();
    const timer = window.setInterval(() => { void sample(); }, 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [showStats, ownerId, readDiagnostics]);

  const resume = () => {
    void ref.current?.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
  };
  const measured = (n: number | null | undefined, suffix: string, digits = 0) =>
    n == null ? "unavailable" : `${n.toFixed(digits)}${suffix}`;
  return (
    <div className="cp-peerstage">
      <video ref={ref} className="cp-peerstage-video" aria-label={isSelf ? "Your shared screen" : `${who}'s shared screen`} playsInline autoPlay muted={isSelf || muted} />
      {!isSelf && <span className="cp-peerstage-badge" role="status">
        {stale ? `No fresh picture from ${who} · last frame` : `Live view of ${who}'s screen`}
      </span>}
      {(!isSelf || blocked) && <div className="cp-peerstage-audio">
        {blocked && <button type="button" onClick={resume}>Start program playback</button>}
        {!isSelf && <><button type="button" onClick={() => {
          // Apply in the user gesture, before play(), rather than waiting for
          // React's effect (important for WebKit's audible autoplay policy).
          if (ref.current) ref.current.muted = !muted;
          setMuted(!muted);
          resume();
        }} aria-pressed={muted}>
          {muted ? "Unmute program" : "Mute program"}
        </button>
        <input aria-label="Program audio volume" type="range" min="0" max="1" step="0.05"
          value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
        <button type="button" aria-expanded={showStats} onClick={() => setShowStats((v) => !v)}>Diagnostics</button>
        </>}
      </div>}
      {!isSelf && showStats && <div className="cp-program-diagnostics">
        <div>Picture: {stats?.width && stats?.height ? `${stats.width} × ${stats.height}` : "unavailable"}</div>
        <div>Frame rate: {measured(stats?.fps, " fps", 1)}</div>
        <div>Receive bitrate: {measured(stats?.bitrate == null ? null : stats.bitrate / 1_000_000, " Mbps", 2)}</div>
        <div>Dropped frames: {measured(stats?.droppedFrames, "")}</div>
        <div>Receive buffer: {measured(stats?.receiveBufferMs, " ms")}</div>
        <div>A/V drift: unavailable (not measured)</div>
      </div>}
    </div>
  );
}
