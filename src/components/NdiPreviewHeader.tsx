import type { ReactNode } from "react";
import { ObsBroadcastIndicator, type ObsBroadcastNotice } from "./ObsBroadcastIndicator";
import "../styles/ndi-preview-header.css";

/** Outside the picture. NDI's stream clock is not sequence timecode. */
export function NdiPreviewHeader({ sharing, children, broadcasts = [] }: {
  sharing: "private" | "shared" | "stopped";
  children?: ReactNode;
  broadcasts?: readonly ObsBroadcastNotice[];
}) {
  return <div className="cp-ndi-preview-header">
    <span className="cp-ndi-publication" role="status">{sharing === "private" ? "Not shared with room" : sharing === "stopped" ? "Room sharing stopped" : "Shared with room"}</span>
    <div className="cp-tc cp-ndi-timecode" role="status" aria-label="Timeline timecode unavailable"
      title="Sequence timecode is unavailable. Live picture timing is not a verified timeline position.">--:--:--:--</div>
    {broadcasts.map(notice => <ObsBroadcastIndicator key={notice.broadcast.sourceId} {...notice}/>)}
    {children && <div className="cp-ndi-preview-actions">{children}</div>}
  </div>;
}
