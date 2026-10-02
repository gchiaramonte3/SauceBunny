import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";
import { multitrackLibraryEntries, type MultitrackLibraryEntry } from "../lib/transcript-library";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";

/** Disk is authoritative, including commits whose original IPC caller has gone. */
export function useMultitrackLibrary(visible: boolean) {
  const [entries, setEntries] = useState<MultitrackLibraryEntry[]>([]);
  const [selected, select] = useState<string | null>(null);
  const [document, setDocument] = useState<AafDocument | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let metadataJob: string | null = null;
    let inspected = false;
    const refresh = async () => {
      const token = ++request.current;
      try {
        const items = await invoke<AafDocumentSummary[]>("aaf_list");
        let doc = selected ? await invoke<AafDocument>("aaf_open", { documentId: selected }) : null;
        if (doc && doc.manifest.recording_dates == null && !inspected && !disposed) {
          inspected = true; metadataJob = newJobId();
          try { doc = await invoke<AafDocument>("aaf_read_recording_dates", { documentId: doc.id, jobId: metadataJob }); }
          catch { /* An offline source must not hide its saved transcript. */ }
          finally { metadataJob = null; }
        }
        if (!disposed && token === request.current) { setEntries(multitrackLibraryEntries(items)); setDocument(doc); setError(""); }
      } catch (cause) { if (!disposed && token === request.current) setError(formatError(cause)); }
    };
    const onSaucebunnyMultitrackChanged = () => { void refresh(); };
    const subscription = listen("saucebunny:multitrack-changed", onSaucebunnyMultitrackChanged);
    void subscription.then(() => { if (!disposed) void refresh(); }).catch(cause => { if (!disposed) setError(formatError(cause)); });
    return () => { disposed = true; if (metadataJob) void invoke("cancel_job", { jobId: metadataJob }).catch(() => {}); void subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, [visible, selected]);
  return { entries, document: document?.id === selected ? document : null, selected, select, error };
}
