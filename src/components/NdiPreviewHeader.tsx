import type { ReactNode } from "react";
import "../styles/ndi-preview-header.css";

/** Outside the picture. NDI's stream clock is not sequence timecode. */
export function NdiPreviewHeader({ sharing, children }: {
  sharing: "private" | "shared" | "stopped";
  children?: ReactNode;
}) {
  return <div className="cp-ndi-preview-header">
    <span className="cp-ndi-publication" role="status">{sharing === "private" ? "Not shared" : sharing === "stopped" ? "Sharing stopped" : "Shared with room"}</span>
    <div className="cp-tc cp-ndi-timecode" role="status" aria-label="Timeline timecode unavailable"
      title="Sequence timecode is unavailable. The NDI stream clock is not a verified timeline position.">--:--:--:--</div>
    {children && <div className="cp-ndi-preview-actions">{children}</div>}
  </div>;
}
