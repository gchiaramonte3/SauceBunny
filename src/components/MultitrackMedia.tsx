import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AafDocument } from "../bindings/AafDocument";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { audioTrackLabel, trackOwner } from "../lib/multitrack";

/** Resolution is document-local and explicit. Never mount a server or launch a
 * URL from metadata. Closing this inspector cancels unfinished resolution. */
export function MultitrackMedia({ document, disabled, onBusy }: { document: AafDocument; disabled?: boolean; onBusy?: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<AafDocument | null>(null);
  const job = useRef<string | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (job.current) void invoke("cancel_job", { jobId: job.current }).catch(() => {}); onBusy?.(false); }; }, [onBusy]);
  const graph = (result ?? document).manifest.graph;
  if (!graph?.sources.length) return null;
  const stop = () => { const id = job.current; job.current = null; setBusy(false); onBusy?.(false); if (id) void invoke("cancel_job", { jobId: id }).catch(cause => setError(formatError(cause))); };
  const resolve = async (kind: "refresh" | "folder" | "file", sourceId?: string) => {
    if (job.current) return;
    const jobId = newJobId(); job.current = jobId; setBusy(true); onBusy?.(true); setError("");
    try {
      const path = kind === "refresh" ? null : await open({ multiple: false, directory: kind === "folder", title: kind === "folder" ? "Locate AAF media folder" : "Locate AAF audio source", ...(kind === "file" ? { filters: [{ name: "PCM audio", extensions: ["wav", "bwf", "mxf"] }] } : {}) });
      if (job.current !== jobId || !mounted.current || (kind !== "refresh" && typeof path !== "string")) return;
      const next = await invoke<AafDocument>("aaf_resolve_media", { documentId: document.id, sourceId: sourceId ?? null, path, jobId });
      if (mounted.current && job.current === jobId) setResult(next);
    } catch (cause) { if (mounted.current && job.current === jobId) setError(formatError(cause)); }
    finally { if (mounted.current && job.current === jobId) { job.current = null; setBusy(false); onBusy?.(false); } }
  };
  return <details className="cp-multitrack-media" open><summary>Linked media · {graph.sources.filter(source => source.status === "ready" && source.resolved).length}/{graph.sources.length} available</summary>
    <div className="cp-multitrack-media-actions"><button className="btn btn-ghost" disabled={busy || disabled} onClick={() => void resolve("folder")}>Locate media folder…</button><button className="btn btn-ghost" disabled={busy || disabled} onClick={() => void resolve("refresh")}>Refresh availability</button>{busy && <button className="btn btn-ghost" onClick={stop}>Stop</button>}</div>
    {busy && <p role="status">Checking media…</p>}{error && <p className="cp-multitrack-error" role="alert">{error}</p>}
    <div className="cp-multitrack-media-list">{graph.sources.map(source => {
      const tracks = document.manifest.tracks.filter(track => track.clips.some(clip => clip.source_id === source.id));
      return <details key={source.id}><summary><span>{tracks.map(track => `${audioTrackLabel(document, track.id)} · ${trackOwner(document, track.id)}`).join(", ")}</span><span>{source.status === "ready" && source.resolved ? "Available" : source.status === "needs_relink" ? "Needs relink" : "Offline"}</span></summary>
        <p>{source.locators.map(path => <span className="cp-multitrack-media-path" key={path}>{path}</span>)}</p>
        <p>Channel {source.channel + 1} of {source.channels} · {source.sample_rate / 1000} kHz · {source.sample_width * 8}-bit</p>
        <p className="cp-multitrack-media-path">Source {source.mob_id} · slot {source.slot_id}</p>
        {source.resolved && <p className="cp-multitrack-media-path">{source.resolved.path}</p>}
        {!!source.ancestors.length && <details><summary>Original source references</summary>{source.ancestors.map((ancestor, index) => <p className="cp-multitrack-media-path" key={index}>{ancestor.locators.join("\n")} · offset {ancestor.start} at {ancestor.edit_rate}</p>)}<p>Original recorder files may have a different time origin from the linked Avid media. They are not substituted automatically.</p></details>}
        <button className="btn btn-ghost" disabled={busy || disabled} onClick={() => void resolve("file", source.id)}>Locate file…</button>
      </details>;
    })}</div>
    <p>Choose a mounted media folder or an individual file. Matching checks format, channel count, duration, and source identifiers when available. Ambiguous matches remain offline. Saved transcripts are retained.</p>
  </details>;
}
