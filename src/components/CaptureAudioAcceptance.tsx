import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ObsAudioAcceptanceStatus } from "../bindings/ObsAudioAcceptanceStatus";
import { startAcceptanceTone, type AcceptanceTone, type AcceptanceToneKind } from "../lib/capture-acceptance-tone";
import "../styles/capture-acceptance.css";

type Attempt = { id: string; tone: AcceptanceTone | null; timer?: ReturnType<typeof setTimeout>; deadline?: ReturnType<typeof setTimeout> };

/** Both renderer and Rust commands are compiled in only for an explicit
 * internal acceptance build. This never starts or publishes a source. */
export function CaptureAudioAcceptance({ sourceId }: { sourceId: string | null }) {
  return <AudioAcceptance key={sourceId ?? "none"} sourceId={sourceId}/>;
}

function AudioAcceptance({ sourceId }: { sourceId: string | null }) {
  const current = useRef<Attempt | null>(null);
  const [message, setMessage] = useState("Choose a private Screen or Region preview. Keep program monitoring muted; play the external 440/660 Hz fixture.");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ObsAudioAcceptanceStatus | null>(null);

  useEffect(() => () => {
    const attempt = current.current;
    current.current = null;
    if (attempt) dispose(attempt);
  }, [sourceId]);

  function finish(attempt: Attempt, message: string, status: ObsAudioAcceptanceStatus | null = null) {
    if (current.current !== attempt) return;
    current.current = null;
    dispose(attempt);
    setRunning(false); setMessage(message); setResult(status);
  }
  async function poll(attempt: Attempt) {
    try {
      const status = await invoke<ObsAudioAcceptanceStatus>("obs_audio_acceptance_read", { attempt: attempt.id });
      if (current.current !== attempt) return;
      if (status.attempt !== attempt.id) throw new Error("Unexpected measurement identity.");
      if (status.phase !== "running") {
        finish(attempt, status.report ? `Measurement ${status.report.verdict}.` : status.error ?? status.phase, status);
      } else {
        attempt.timer = setTimeout(() => void poll(attempt), 500);
      }
    } catch {
      finish(attempt, "Measurement unavailable. Test tones stopped; no pass recorded.");
    }
  }
  async function start(kind: AcceptanceToneKind) {
    if (!sourceId || current.current) return;
    const attempt: Attempt = { id: crypto.randomUUID(), tone: null };
    current.current = attempt;
    setRunning(true); setResult(null); setMessage(`Measuring ${kind === "html" ? "HTML audio" : "Web Audio"} isolation…`);
    attempt.deadline = setTimeout(() => finish(attempt, "Measurement timed out. Test tones stopped; no pass recorded."), 18_000);
    try {
      attempt.tone = startAcceptanceTone(kind);
      await attempt.tone.ready;
      if (current.current !== attempt) return;
      await invoke("obs_audio_acceptance_start", { id: sourceId, attempt: attempt.id });
      if (current.current !== attempt) { dispose(attempt); return; }
      void poll(attempt);
    } catch {
      finish(attempt, "Measurement could not start. Test tones stopped; no pass recorded.");
    }
  }
  const report = result?.report;
  return <details className="cp-capture-acceptance">
    <summary>Internal capture audio test</summary>
    <p role="status">{message}</p>
    <div className="cp-capture-acceptance-actions">
      <button className="btn" disabled={!sourceId || running} onClick={() => void start("html")}>Measure HTML audio</button>
      <button className="btn" disabled={!sourceId || running} onClick={() => void start("web-audio")}>Measure Web Audio</button>
      <button className="btn" disabled={!running} onClick={() => {
        if (current.current) finish(current.current, "Measurement cancelled. Test tones stopped.");
      }}>Stop test tones</button>
    </div>
    {report && <section aria-label="Audio measurement summary">{(["capture", "reference"] as const).map(kind =>
      report[kind].channels.map((channel, index) => {
        const label = `${kind === "capture" ? "Capture" : "Reference"} ${index === 0 ? "left" : "right"}`;
        return <div className="cp-capture-acceptance-channel" role="group" aria-label={`${label} channel`} key={`${kind}-${index}`}>
          <span>{label}</span>
          <span>{`RMS ${channel.rms.toExponential(3)}`}</span>
          <span>{`Quiet ${channel.longestQuietMs.toFixed(1)} ms`}</span>
          {[440, 660, 880, 1320].map((frequency, tone) => <span key={frequency}>
            {`${frequency} Hz min ${channel.minimumTone[tone].toExponential(3)} max ${channel.maximumTone[tone].toExponential(3)}`}
          </span>)}
        </div>;
      }))}</section>}
    {result && <pre aria-label="Numeric audio measurement">{JSON.stringify(result, null, 2)}</pre>}
  </details>;
}

function dispose(attempt: Attempt) {
  clearTimeout(attempt.timer); clearTimeout(attempt.deadline);
  try { attempt.tone?.stop(); } catch { /* Native cancellation must still run. */ }
  finally { void invoke("obs_audio_acceptance_cancel", { attempt: attempt.id }).catch(() => {}); }
}
