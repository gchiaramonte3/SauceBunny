import { useSyncExternalStore } from "react";
import { getPremiereLink, premiereBindingForSource, subscribePremiereLink } from "../lib/premiere-link";

/** Passive status and one setup disclosure; the NDI transport is untouched. */
export function PremiereConnectionStatus({ sourceId, onSetup }: { sourceId: string; onSetup?: () => void }) {
  useSyncExternalStore(subscribePremiereLink, getPremiereLink);
  const binding = premiereBindingForSource(sourceId);
  return <div className="cp-premiere-connection-status">
    <p role="status">{binding ? `Notes → ${binding.sequenceName} · Editor-confirmed timing`
      : "Timeline markers are not connected. NDI picture and audio are separate."}</p>
    {onSetup && <button type="button" className="cp-toolbar-disclosure" aria-haspopup="dialog" onClick={onSetup}>Marker setup…</button>}
  </div>;
}
