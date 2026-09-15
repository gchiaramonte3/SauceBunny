import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";
import type { AafTrackTranscript } from "../bindings/AafTrackTranscript";
import type { AafWaveform } from "../bindings/AafWaveform";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { mergeTrackTranscript } from "../lib/multitrack";

export function useMultitrackDocument(active: boolean) {
  const [document, setDocument] = useState<AafDocument | null>(null);
  const [saved, setSaved] = useState<AafDocumentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelStatus, setLabelStatus] = useState("");
  const [waveforms, setWaveforms] = useState<Record<string, number[][]>>({});
  const [waveformErrors, setWaveformErrors] = useState<Record<string, string>>({});
  const current = useRef(document); current.current = document;
  const importJob = useRef<string | null>(null);
  const revision = useRef(0);
  const saves = useRef(new Map<string, Promise<void>>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (importJob.current) void invoke("cancel_job", { jobId: importJob.current }).catch(() => {}); }; }, []);
  useEffect(() => {
    if (!active) return;
    let valid = true;
    void invoke<AafDocumentSummary[]>("aaf_list").then((items) => { if (valid) setSaved(items); }).catch((cause) => { if (valid) setError(formatError(cause)); });
    return () => { valid = false; };
  }, [active, document?.id]);

  const cancelImport = useCallback(() => {
    ++revision.current;
    const jobId = importJob.current; importJob.current = null;
    setLoading(false);
    if (jobId) void invoke("cancel_job", { jobId }).catch((cause) => setError(formatError(cause)));
  }, []);
  const load = useCallback(async (documentId?: string) => {
    if (importJob.current) return;
    const token = ++revision.current;
    const jobId = newJobId(); importJob.current = jobId;
    setLoading(true); setError(null);
    try {
      const path = documentId ? null : await open({ multiple: false, directory: false, filters: [{ name: "AAF sequence", extensions: ["aaf"] }] });
      if (token !== revision.current || !mounted.current || (!documentId && typeof path !== "string")) return;
      let next: AafDocument;
      if (documentId) {
        // Opening another sequence does not cancel this one's queued writes.
        // A read that overlaps a newer label edit must not restore its old snapshot.
        for (;;) {
          const pending = saves.current.get(documentId);
          if (pending) await pending;
          if (token !== revision.current || !mounted.current) return;
          next = await invoke<AafDocument>("aaf_open", { documentId });
          if (pending === saves.current.get(documentId)) break;
        }
      } else next = await invoke<AafDocument>("aaf_import", { path, jobId });
      if (token === revision.current && mounted.current) { current.current = next; setDocument(next); setLabelStatus(""); }
    } catch (cause) { if (token === revision.current && mounted.current) setError(formatError(cause)); }
    finally { if (token === revision.current && mounted.current) { importJob.current = null; setLoading(false); } }
  }, []);

  const documentId = document?.id;
  const tracks = document?.manifest.tracks;
  const waveformCache = useRef<Record<string, number[][]>>({});
  useEffect(() => { waveformCache.current = {}; setWaveforms({}); setWaveformErrors({}); }, [documentId]);
  useEffect(() => {
    if (!active || loading || !documentId || !tracks) return;
    let cancelled = false;
    let jobId: string | null = null;
    void (async () => {
      for (const track of tracks) {
        if (cancelled) break;
        if (waveformCache.current[track.id]) continue;
        jobId = newJobId();
        try {
          const waveform = await invoke<AafWaveform>("aaf_waveform", { documentId, trackId: track.id, jobId });
          if (!cancelled) { waveformCache.current[track.id] = waveform.peaks; setWaveforms((prior) => ({ ...prior, [track.id]: waveform.peaks })); }
        } catch (cause) { if (!cancelled) setWaveformErrors((prior) => ({ ...prior, [track.id]: formatError(cause) })); }
      }
      jobId = null;
    })();
    return () => { cancelled = true; if (jobId) void invoke("cancel_job", { jobId }).catch(() => {}); };
  }, [active, loading, documentId, tracks]);

  const rename = useCallback((trackId: string, ownerName: string, castMemberId: string | null = null, color: string | null = null) => {
    const before = current.current;
    if (!before) return;
    const labels = [...before.labels.filter((label) => label.track_id !== trackId), { track_id: trackId, owner_name: ownerName.trim().normalize("NFC"), cast_member_id: castMemberId, color }];
    const next = { ...before, labels }; current.current = next; setDocument(next); setLabelStatus("Saving labels…");
    // Serialize writes so an older blur cannot overwrite a newer mic label.
    const save = (saves.current.get(before.id) ?? Promise.resolve()).then(async () => {
      try {
        await invoke<AafDocument>("aaf_save_labels", { documentId: before.id, labels });
        if (mounted.current && current.current?.id === before.id && saves.current.get(before.id) === save) setLabelStatus("Labels saved locally");
      } catch (cause) { if (mounted.current && current.current?.id === before.id) { setLabelStatus("Labels not saved"); setError(formatError(cause)); } }
    });
    saves.current.set(before.id, save);
  }, []);
  const acceptTranscript = useCallback((transcript: AafTrackTranscript) => {
    const before = current.current;
    if (!before) return;
    const next = mergeTrackTranscript(before, transcript); current.current = next; setDocument(next);
  }, []);
  return { document, saved, loading, error, labelStatus, waveforms, waveformErrors, load, cancelImport, rename, acceptTranscript };
}
