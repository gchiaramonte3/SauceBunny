import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { copyText } from "../lib/clipboard";
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { AafDiagnosticEvent } from "../bindings/AafDiagnosticEvent";
import type { AafDiagnostics } from "../bindings/AafDiagnostics";
import type { PipelineHealth } from "../bindings/PipelineHealth";
import { diagnosticsFilename } from "../lib/diagnostics";
import { mergeMultitrackLogs } from "../lib/multitrack-diagnostics";
import { callStats, inFlight, pipelineActivity, pipelineContext, subscribePipelineActivity, watchPage } from "../lib/pipeline";
import { pipelineReport } from "../lib/pipeline-report";
import { formatError } from "../lib/error-format";
import { LogsPanel } from "./LogsPanel";

/** The pages that carry a Pipeline, and the file name their export takes. */
export type PipelinePage = "AAF Audio" | "String Outs";
const FILE_PREFIX: Record<PipelinePage, string> = { "AAF Audio": "aaf-audio-diagnostics", "String Outs": "string-outs-diagnostics" };
/** The most AAF Audio documents one export describes (each context carries a whole manifest). */
const MAX_CONTEXTS = 4;

const validHealth = (value: unknown): value is PipelineHealth => !!value && typeof value === "object"
  && Array.isArray((value as PipelineHealth).volumes) && Array.isArray((value as PipelineHealth).running_jobs)
  && typeof (value as PipelineHealth).uptime_seconds === "number";

/**
 * The Pipeline: one log for the whole app, shown at the foot of AAF Audio and
 * String Outs, and opened from either with ⌘\ (view.logs), the same switch
 * as the Clip view's. Native history survives navigation and relaunches;
 * the page's own rows (lib/pipeline) land in the same journal. Mounted even
 * before an import succeeds, and subscribed before the snapshot so short
 * failures are not lost.
 */
export function PipelinePanel({ page, active, open, onOpenChange, documentId, error, loading, emptyMessage }: {
  page: PipelinePage; active: boolean; open: boolean; onOpenChange: (open: boolean) => void;
  documentId?: string; error?: string | null; loading?: boolean; emptyMessage?: string;
}) {
  const [rows, setRows] = useState<AafDiagnosticEvent[]>([]);
  const [jobs, setJobs] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const activity = useSyncExternalStore(subscribePipelineActivity, pipelineActivity);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const reveal = useRef(onOpenChange); reveal.current = onOpenChange;
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const add = useCallback((message: string, level = "info") => {
    if (!mounted.current) return;
    const row: AafDiagnosticEvent = { id: crypto.randomUUID(), timestamp_ms: Date.now(), job_id: "", level, stage: "diagnostics", message, active: null };
    setRows(previous => mergeMultitrackLogs(previous, [row]));
    reveal.current(true);
  }, []);
  useEffect(() => {
    if (!active) return;
    return watchPage(page);
  }, [active, page]);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const buffered: AafDiagnosticEvent[] = [];
    let hydrated = false;
    // A relink logs several rows per source. Merging and re-rendering 1,500
    // rows per event saturated the webview, so rows are applied in batches.
    let pending: AafDiagnosticEvent[] = [];
    let flush: number | null = null;
    function applyPending() {
      flush = null;
      const batch = pending; pending = [];
      if (disposed || !batch.length) return;
      setRows(previous => mergeMultitrackLogs(previous, batch));
      const lifecycle = batch.filter(row => row.active !== null);
      if (lifecycle.length) setJobs(previous => {
        const next = new Set(previous);
        for (const row of lifecycle) { if (row.active) next.add(row.job_id); else next.delete(row.job_id); }
        return next;
      });
      if (batch.some(row => row.level === "err")) reveal.current(true);
    }
    function onAafDiagnostic({ payload }: Event<AafDiagnosticEvent>) {
      if (disposed) return;
      if (!hydrated) { buffered.push(payload); if (buffered.length > 1500) buffered.shift(); }
      pending.push(payload);
      // Errors are rare and open the panel, so they never wait for the batch.
      if (payload.level === "err") { if (flush !== null) clearTimeout(flush); applyPending(); }
      else if (flush === null) flush = window.setTimeout(applyPending, 250);
    }
    const subscription = listen<AafDiagnosticEvent>("aaf-diagnostic", onAafDiagnostic);
    void subscription.then(async () => {
      const snapshot = await invoke<AafDiagnostics>("aaf_diagnostics", { documentId: null });
      if (disposed) return;
      setRows(previous => mergeMultitrackLogs(snapshot.events, previous));
      const running = new Set(snapshot.active_jobs);
      for (const row of buffered) if (row.active !== null) { if (row.active) running.add(row.job_id); else running.delete(row.job_id); }
      hydrated = true;
      buffered.length = 0;
      setJobs(running);
      if (snapshot.persistence_error) add(`Log persistence: ${snapshot.persistence_error}`, "warn");
    }).catch(cause => {
      hydrated = true; buffered.length = 0;
      if (!disposed) add(`Cannot load native diagnostics: ${formatError(cause)}`, "err");
    });
    return () => { disposed = true; mounted.current = false; if (flush !== null) clearTimeout(flush); void subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, [add]);
  useEffect(() => { if (error) add(error, "err"); }, [error, add]);

  const report = async () => {
    const context = pipelineContext(page);
    const ids = [...new Set(documentId ? [documentId] : context?.documentIds ?? [])].slice(0, MAX_CONTEXTS);
    const snapshots = await Promise.all((ids.length ? ids : [null]).map(async (id): Promise<AafDiagnostics> => {
      try { return await invoke<AafDiagnostics>("aaf_diagnostics", { documentId: id }); }
      catch (cause) { return { events: [], active_jobs: [...jobs], persistence_error: formatError(cause), context: "Native context unavailable. Frontend log follows." }; }
    }));
    let health: PipelineHealth | null = null, healthError: string | null = null;
    try { const value = await invoke<unknown>("pipeline_health"); if (validHealth(value)) health = value; else healthError = "unreadable answer"; }
    catch (cause) { healthError = formatError(cause); }
    return pipelineReport({ page, snapshots, rows: rowsRef.current, health, healthError, context, inflight: inFlight(), stats: callStats(), userAgent: navigator.userAgent });
  };
  const exportReport = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try {
      const path = await save({ title: `Save ${page} diagnostics`, defaultPath: diagnosticsFilename(new Date()).replace("saucebunny-diagnostics", `saucebunny-${FILE_PREFIX[page]}`), filters: [{ name: "Text", extensions: ["txt"] }] });
      if (!path) return;
      const text = await report();
      await invoke("write_text_to_path", { path, text, atomic: true });
      add(`Diagnostics saved: ${path}. Review the media paths before sharing.`, "ok");
    } catch (cause) { add(`Diagnostics export failed: ${formatError(cause)}`, "err"); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  };
  // The write starts in the click, before the report is built (lib/clipboard).
  const copy = async () => {
    try { await copyText(report()); add("Diagnostics copied. Includes media paths.", "ok"); }
    catch (cause) { add(`Copy failed: ${formatError(cause)}`, "err"); }
  };
  const clear = async () => {
    try {
      await invoke("aaf_clear_diagnostics");
      const snapshot = await invoke<AafDiagnostics>("aaf_diagnostics", { documentId: null });
      if (mounted.current) setRows(snapshot.events);
    } catch (cause) { add(`Could not clear diagnostics: ${formatError(cause)}`, "err"); }
  };
  const busy = loading || jobs.size > 0 || activity.busy;
  return <LogsPanel open={open} onToggle={() => onOpenChange(!open)} status={busy ? "fetching" : error ? "error" : documentId ? "loaded" : "empty"} progress={0}
    activityLabel={activity.waiting ? "WAITING" : busy ? "WORKING" : undefined} actionsDisabled={saving}
    emptyMessage={emptyMessage ?? "Nothing logged yet. Export diagnostics includes the app's health, what the page is waiting on, and every recent operation."}
    lines={rows.map((row, index) => ({ id: index, ts: new Date(row.timestamp_ms).toLocaleTimeString([], { hour12: false }), tag: row.level === "err" ? "err" : row.level === "warn" ? "warn" : row.level === "ok" ? "ok" : "info", source: row.stage === "health" ? "HEALTH" : row.stage === "String Outs" || row.stage === "AAF Audio" ? "PAGE" : "AAF", message: `${row.stage} · ${row.message}` }))}
    onExportDiagnostics={() => void exportReport()} onCopy={() => void copy()} onClear={() => void clear()} />;
}
