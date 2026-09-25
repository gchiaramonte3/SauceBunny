import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { AafDiagnosticEvent } from "../bindings/AafDiagnosticEvent";
import type { AafDiagnostics } from "../bindings/AafDiagnostics";
import { diagnosticsFilename } from "../lib/diagnostics";
import { mergeMultitrackLogs, multitrackDiagnosticsText } from "../lib/multitrack-diagnostics";
import { formatError } from "../lib/error-format";
import { LogsPanel } from "./LogsPanel";

/** Mounted even before import succeeds. Native history survives navigation and
 * app restarts; subscribe before the snapshot so short failures are not lost. */
export function MultitrackPipeline({ documentId, error, loading }: { documentId?: string; error?: string | null; loading?: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AafDiagnosticEvent[]>([]);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const add = useCallback((message: string, level = "info") => {
    if (!mounted.current) return;
    const row: AafDiagnosticEvent = { id: crypto.randomUUID(), timestamp_ms: Date.now(), job_id: "", level, stage: "diagnostics", message, active: null };
    setRows(previous => mergeMultitrackLogs(previous, [row]));
    setOpen(true);
  }, []);
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
      if (lifecycle.length) setActive(previous => {
        const next = new Set(previous);
        for (const row of lifecycle) { if (row.active) next.add(row.job_id); else next.delete(row.job_id); }
        return next;
      });
      if (batch.some(row => row.level === "err")) setOpen(true);
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
      const jobs = new Set(snapshot.active_jobs);
      for (const row of buffered) if (row.active !== null) { if (row.active) jobs.add(row.job_id); else jobs.delete(row.job_id); }
      hydrated = true;
      buffered.length = 0;
      setActive(jobs);
      if (snapshot.persistence_error) add(`Log persistence: ${snapshot.persistence_error}`, "warn");
    }).catch(cause => {
      hydrated = true; buffered.length = 0;
      if (!disposed) add(`Cannot load native diagnostics: ${formatError(cause)}`, "err");
    });
    return () => { disposed = true; mounted.current = false; if (flush !== null) clearTimeout(flush); void subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, [add]);
  useEffect(() => { if (error) add(error, "err"); }, [error, add]);

  const report = async () => {
    let snapshot: AafDiagnostics;
    try { snapshot = await invoke<AafDiagnostics>("aaf_diagnostics", { documentId: documentId ?? null }); }
    catch (cause) { snapshot = { events: [], active_jobs: [...active], persistence_error: formatError(cause), context: "Native context unavailable. Frontend log follows." }; }
    return multitrackDiagnosticsText(snapshot, rowsRef.current, navigator.userAgent);
  };
  const exportReport = async () => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try {
      const path = await save({ title: "Save Multitrack diagnostics", defaultPath: diagnosticsFilename(new Date()).replace("diagnostics", "multitrack-diagnostics"), filters: [{ name: "Text", extensions: ["txt"] }] });
      if (!path) return;
      const text = await report();
      await invoke("write_text_to_path", { path, text, atomic: true });
      add(`Diagnostics saved: ${path}. Review the media paths before sharing.`, "ok");
    } catch (cause) { add(`Diagnostics export failed: ${formatError(cause)}`, "err"); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(await report()); add("Diagnostics copied. Includes media paths.", "ok"); }
    catch (cause) { add(`Copy failed: ${formatError(cause)}`, "err"); }
  };
  const clear = async () => {
    try {
      await invoke("aaf_clear_diagnostics");
      const snapshot = await invoke<AafDiagnostics>("aaf_diagnostics", { documentId: null });
      if (mounted.current) setRows(snapshot.events);
    } catch (cause) { add(`Could not clear diagnostics: ${formatError(cause)}`, "err"); }
  };
  const busy = loading || active.size > 0;
  return <LogsPanel open={open} onToggle={() => setOpen(value => !value)} status={busy ? "fetching" : error ? "error" : documentId ? "loaded" : "empty"} progress={0}
    activityLabel={busy ? "WORKING" : undefined} actionsDisabled={saving}
    emptyMessage="Import an AAF to log media discovery. Export diagnostics includes offline paths and matching errors."
    lines={rows.map((row, index) => ({ id: index, ts: new Date(row.timestamp_ms).toLocaleTimeString([], { hour12: false }), tag: row.level === "err" ? "err" : row.level === "warn" ? "warn" : row.level === "ok" ? "ok" : "info", source: "AAF", message: `${row.stage} · ${row.message}` }))}
    onExportDiagnostics={() => void exportReport()} onCopy={() => void copy()} onClear={() => void clear()} />;
}
