import { IconFolderOffline } from "./Icons";
import { offlineCopy } from "../lib/media-offline";
import type { MediaState } from "../bindings/MediaState";

/**
 * A library root that cannot be reached, on Home: why, where it was, and the
 * next step. Offline is a state rather than an error, so it is not drawn in
 * red, and nothing is removed until the person clicks Remove.
 */
export function LibraryOfflineRoot({ root, label, state, volume, onLocate, onRetry, onRemove }: {
  root: string; label: string; state: Exclude<MediaState, "online">; volume: string | null;
  onLocate: () => void; onRetry: () => void; onRemove: () => void;
}) {
  const copy = offlineCopy(state, volume);
  return <section className="cp-lib-row">
    <div className="cp-lib-row-head">
      <h2 className="cp-lib-row-title">{label}</h2>
      <span className="cp-lib-row-count">Offline</span>
    </div>
    <div className="cp-lib-offline" role="status" aria-label={`${label}: ${copy.title}`}>
      <IconFolderOffline size={20} className="cp-lib-offline-icon"/>
      <div className="cp-lib-offline-text">
        <strong>{copy.title}</strong>
        <span className="cp-lib-offline-path" title={root}>{root}</span>
        <span>{copy.hint}</span>
      </div>
      <div className="cp-lib-offline-actions">
        {copy.locate && <button type="button" className="btn" onClick={onLocate}>Locate folder…</button>}
        {copy.retry && <button type="button" className="btn btn-ghost" onClick={onRetry}>Retry</button>}
        <button type="button" className="btn btn-ghost" aria-label={`Remove ${label} from library`} onClick={onRemove}>Remove</button>
      </div>
    </div>
  </section>;
}
