import type { AafDocument } from "../bindings/AafDocument";
import { linkCounts, useMultitrackRelink } from "../hooks/use-multitrack-relink";

/** Link status where the work happens: how much of the sequence's media is
 * linked, and the two actions that fix the rest, without opening Settings.
 * Hidden once everything is linked and nothing is running. */
export function MultitrackMediaStatus({ document, resolving, disabled, onBusy, onDetails }: { document: AafDocument; resolving?: boolean; disabled?: boolean; onBusy?: (busy: boolean) => void; onDetails?: () => void }) {
  const { busy, error, stop, resolve } = useMultitrackRelink(document.id, onBusy);
  const { total, linked, offline, needsRelink } = linkCounts(document);
  if (!total || linked === total && !busy && !resolving && !error) return null;
  const parts = [`${linked} of ${total} media files linked`, offline && `${offline} offline`, needsRelink && `${needsRelink} need relink`].filter(Boolean).join(" · ");
  return <div className="cp-multitrack-media-status" role="group" aria-label="Linked media">
    <span role="status">{busy || resolving ? `Checking media… ${parts}` : parts}</span>
    <button className="btn btn-ghost" disabled={busy || resolving || disabled} onClick={() => void resolve("folder")}>Relink folder…</button>
    <button className="btn btn-ghost" disabled={busy || resolving || disabled} onClick={() => void resolve("refresh")}>Refresh</button>
    {busy && <button className="btn btn-ghost" onClick={stop}>Stop</button>}
    {onDetails && <button className="btn btn-ghost" onClick={onDetails}>Details</button>}
    {error && <span className="cp-multitrack-error" role="alert">{error}</span>}
  </div>;
}
