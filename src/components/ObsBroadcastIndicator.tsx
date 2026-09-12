import type { ObsBroadcast } from "../hooks/use-obs-broadcast";
import "../styles/ndi-preview-header.css";

export type ObsBroadcastNotice = { broadcast: ObsBroadcast; sourceName?: string };

/** Outside the picture and independent of room publication. Never starts a
 * sender; Stop always targets the exact source and attempt held by App. */
export function ObsBroadcastIndicator({ broadcast, sourceName }: ObsBroadcastNotice) {
  const { sourceId, status, error, active, stop } = broadcast;
  if (!sourceId || (!active && !error && status?.phase !== "error")) return null;
  const text = error ? "NDI broadcast status unavailable"
    : status?.phase === "starting" ? "Starting NDI broadcast…"
    : status?.phase === "stopping" ? "Stopping NDI broadcast…"
    : status?.phase === "live" ? "Broadcasting to NDI" : "NDI broadcast needs attention";
  return <div className="cp-ndi-broadcast-notice">
    <span role="status" aria-label="Network broadcast" title={error || status?.error || undefined}>
      {text}{sourceName ? ` · ${sourceName}` : ""}
    </span>
    {active && <button type="button" className="cp-toolbar-disclosure" disabled={status?.phase === "stopping"}
      aria-label={sourceName ? `Stop NDI broadcast from ${sourceName}` : "Stop NDI broadcast"}
      onKeyDown={event => { if (event.key === " ") event.stopPropagation(); }}
      onClick={() => { void stop(); }}>Stop broadcast</button>}
  </div>;
}
