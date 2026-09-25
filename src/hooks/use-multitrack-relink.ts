import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AafDocument } from "../bindings/AafDocument";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";

/** One relink job at a time: refresh known paths, search a chosen folder, or
 * bind one source to a chosen file. Unmounting cancels unfinished resolution,
 * and a URL or server in metadata is never followed. */
export function useMultitrackRelink(documentId: string, onBusy?: (busy: boolean) => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<AafDocument | null>(null);
  const job = useRef<string | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (job.current) void invoke("cancel_job", { jobId: job.current }).catch(() => {}); onBusy?.(false); }; }, [onBusy]);
  const stop = () => { const id = job.current; job.current = null; setBusy(false); onBusy?.(false); if (id) void invoke("cancel_job", { jobId: id }).catch(cause => setError(formatError(cause))); };
  const resolve = async (kind: "refresh" | "folder" | "file", sourceId?: string, chosen?: string) => {
    if (job.current) return;
    const jobId = newJobId(); job.current = jobId; setBusy(true); onBusy?.(true); setError("");
    try {
      const path = kind === "refresh" ? null : chosen ?? await open({ multiple: false, directory: kind === "folder", title: kind === "folder" ? "Locate AAF media folder" : "Locate AAF audio source", ...(kind === "file" ? { filters: [{ name: "PCM audio", extensions: ["wav", "bwf", "mxf"] }] } : {}) });
      if (job.current !== jobId || !mounted.current || (kind !== "refresh" && typeof path !== "string")) return;
      const next = await invoke<AafDocument>("aaf_resolve_media", { documentId, sourceId: sourceId ?? null, path, jobId });
      if (mounted.current && job.current === jobId) setResult(next);
    } catch (cause) { if (mounted.current && job.current === jobId) setError(formatError(cause)); }
    finally { if (mounted.current && job.current === jobId) { job.current = null; setBusy(false); onBusy?.(false); } }
  };
  const clearResult = useCallback(() => setResult(null), []);
  return { busy, error, result, clearResult, stop, resolve };
}

/** Counts for the media strip; "linked" means verified and bound. */
export function linkCounts(document: AafDocument) {
  const sources = document.manifest.graph?.sources ?? [];
  return { total: sources.length, linked: sources.filter(source => source.status === "ready" && source.resolved).length,
    offline: sources.filter(source => source.status === "offline").length, needsRelink: sources.filter(source => source.status === "needs_relink").length };
}
