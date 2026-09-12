import type { ObsBroadcast } from "../hooks/use-obs-broadcast";

/** Presentation only. App keeps observing the sender after this popup closes. */
export function ObsBroadcastControls({ broadcast, disabled = false }: { broadcast: ObsBroadcast; disabled?: boolean }) {
  const { status, error, active, start, stop } = broadcast;
  const text = !status ? error ? "Broadcast status unavailable" : "Checking broadcast…"
    : error ? "Broadcast status unavailable. Last known state retained."
    : status.phase === "live" ? "Broadcasting on your local network"
    : status.phase === "starting" ? "Starting broadcast…" : status.phase === "stopping" ? "Stopping broadcast…"
    : status.phase === "error" ? "Broadcast needs attention" : "Not broadcasting";
  return <div className="cp-obs-broadcast">
    <p role="status" aria-label="NDI broadcast">{text}</p>
    <p>Broadcast sends this window and application audio to NDI receivers on your network. It is separate from sharing with a Sauce Bunny room.</p>
    {error || status?.error ? <p role="alert">{error || status?.error}</p> : null}
    <button type="button" className="cp-toolbar-disclosure" disabled={!status || status.phase === "stopping" || (!active && (disabled || !!error))}
      onClick={() => { void (active ? stop() : start()); }}>{active ? "Stop broadcast" : "Broadcast to NDI"}</button>
  </div>;
}
