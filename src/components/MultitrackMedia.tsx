import { useEffect } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import { linkCounts, useMultitrackRelink } from "../hooks/use-multitrack-relink";
import { audioTrackLabel, trackOwner } from "../lib/multitrack";

/** Every source with its links and actions. Resolution is document-local and
 * explicit; closing this inspector cancels unfinished resolution. */
export function MultitrackMedia({ document, disabled, onBusy }: { document: AafDocument; disabled?: boolean; onBusy?: (busy: boolean) => void }) {
  const { busy, error, result, clearResult, stop, resolve } = useMultitrackRelink(document.id, onBusy);
  useEffect(() => { clearResult(); }, [document, clearResult]);
  const current = result ?? document, graph = current.manifest.graph, counts = linkCounts(current);
  if (!graph?.sources.length) return null;
  return <details className="cp-multitrack-media" open><summary>Linked media · {counts.linked}/{counts.total} available</summary>
    <div className="cp-multitrack-media-actions"><button className="btn btn-ghost" disabled={busy || disabled} onClick={() => void resolve("folder")}>Locate media folder…</button><button className="btn btn-ghost" disabled={busy || disabled} onClick={() => void resolve("refresh")}>Refresh availability</button>{busy && <button className="btn btn-ghost" onClick={stop}>Stop</button>}</div>
    {busy && <p role="status">Checking media…</p>}{error && <p className="cp-multitrack-error" role="alert">{error}</p>}
    <div className="cp-multitrack-media-list">{graph.sources.map(source => {
      const tracks = document.manifest.tracks.filter(track => track.clips.some(clip => clip.source_id === source.id));
      return <details key={source.id}><summary><span>{tracks.map(track => `${audioTrackLabel(document, track.id)} · ${trackOwner(document, track.id)}`).join(", ")}</span><span>{source.status === "ready" && source.resolved ? "Available" : source.status === "needs_relink" ? "Needs relink" : "Offline"}</span></summary>
        <p>{source.locators.map(path => <span className="cp-multitrack-media-path" key={path}>{path}</span>)}</p>
        <p>Channel {source.channel + 1} of {source.channels} · {source.sample_rate / 1000} kHz · {source.sample_width * 8}-bit</p>
        <p className="cp-multitrack-media-path">Source {source.mob_id} · slot {source.slot_id}</p>
        {source.resolution_note && <p className="cp-multitrack-media-path">{source.resolution_note}</p>}
        {source.resolved && <p className="cp-multitrack-media-path">{source.resolved.path}</p>}
        {!!source.candidates?.length && <div className="cp-multitrack-media-candidates" role="group" aria-label={`Matching copies for ${source.mob_id} slot ${source.slot_id}`}>
          {source.candidates.map(path => <p key={path}><span className="cp-multitrack-media-path">{path}</span><button className="btn btn-ghost" disabled={busy || disabled} aria-label={`Use this copy: ${path}`} onClick={() => void resolve("file", source.id, path)}>Use this copy</button></p>)}
        </div>}
        {!!source.ancestors.length && <details><summary>Original source references</summary>{source.ancestors.map((ancestor, index) => <p className="cp-multitrack-media-path" key={index}>{ancestor.locators.join("\n")} · offset {ancestor.start} at {ancestor.edit_rate}</p>)}<p>Original recorder files may have a different time origin from the linked Avid media. They are not substituted automatically.</p></details>}
        <button className="btn btn-ghost" disabled={busy || disabled} onClick={() => void resolve("file", source.id)}>Locate file…</button>
      </details>;
    })}</div>
    <p>Choose a mounted media folder or an individual file. Matching checks format, channel count, duration, and source identifiers when available. When several copies match, none is chosen for you: pick one with Use this copy. Saved transcripts are retained.</p>
  </details>;
}
