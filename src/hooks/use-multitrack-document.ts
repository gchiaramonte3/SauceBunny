import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";
import type { AafTrackTranscript } from "../bindings/AafTrackTranscript";
import type { AafWaveform } from "../bindings/AafWaveform";
import type { AafTrackLabel } from "../bindings/AafTrackLabel";
import type { AafSequenceChoice } from "../bindings/AafSequenceChoice";
import { alternativeLane, laneReady, mediaRevision } from "../lib/multitrack-graph";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { mergeTrackTranscript } from "../lib/multitrack";

export function useMultitrackDocument(active: boolean) {
  const [document, setDocument] = useState<AafDocument | null>(null);
  const [saved, setSaved] = useState<AafDocumentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [sequenceChoices, setSequenceChoices] = useState<{ path: string; choices: AafSequenceChoice[] } | null>(null);
  const [visible, setVisible] = useState<string[]>([]);
  const showTracks = useCallback((ids: string[]) => setVisible(prior => prior.join("|") === ids.join("|") ? prior : ids), []);
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
  const load = useCallback(async (documentId?: string, selectedPath?: string, sequenceId?: string) => {
    if (importJob.current) return;
    const token = ++revision.current;
    let jobId = newJobId(); importJob.current = jobId;
    setLoading(true); setError(null);
    try {
      const path = documentId ? null : selectedPath ?? await open({ multiple: false, directory: false, filters: [{ name: "AAF sequence", extensions: ["aaf"] }] });
      if (token !== revision.current || !mounted.current || (!documentId && typeof path !== "string")) return;
      if (!documentId && !sequenceId) {
        const choices = await invoke<AafSequenceChoice[]>("aaf_sequences", { path, jobId });
        if (token !== revision.current || !mounted.current) return;
        if (choices.length > 1) { setSequenceChoices({ path: path as string, choices }); return; }
        sequenceId = choices[0]?.id;
        jobId = newJobId(); importJob.current = jobId;
      }
      setSequenceChoices(null);
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
      } else next = await invoke<AafDocument>("aaf_import", { path, jobId, sequenceId: sequenceId ?? null });
      const labelsBeforeMetadata = saves.current.get(next.id);
      if (next.manifest.graph?.sources.length && token === revision.current && mounted.current) {
        jobId = newJobId(); importJob.current = jobId;
        try { next = await invoke<AafDocument>("aaf_resolve_media", { documentId: next.id, jobId }); }
        catch { /* Offline projects still open; preparing media checks identity again. */ }
      }
      if (next.manifest.recording_dates == null && token === revision.current && mounted.current) {
        try { next = await invoke<AafDocument>("aaf_read_recording_dates", { documentId: next.id, jobId }); }
        catch { /* Saved text remains readable when the original media is offline. */ }
      }
      // A metadata inspection or unchanged-source import can overlap another
      // label edit too. Reconcile behind that document's complete write queue.
      if ((!documentId && saves.current.has(next.id)) || labelsBeforeMetadata !== saves.current.get(next.id)) {
        for (;;) {
          const pending = saves.current.get(next.id);
          await pending;
          if (token !== revision.current || !mounted.current) return;
          next = await invoke<AafDocument>("aaf_open", { documentId: next.id });
          if (pending === saves.current.get(next.id)) break;
        }
      }
      if (token === revision.current && mounted.current) { current.current = next; setDocument(next); setLabelStatus(""); }
    } catch (cause) { if (token === revision.current && mounted.current) setError(formatError(cause)); }
    finally { if (token === revision.current && mounted.current) { importJob.current = null; setLoading(false); } }
  }, []);

  const documentId = document?.id;
  useEffect(() => {
    let disposed = false;
    const onSaucebunnyMultitrackChanged = async (event: { payload: string }) => {
      if (event.payload !== documentId) return;
      const before = current.current;
      try {
        await saves.current.get(event.payload);
        const saved = await invoke<AafDocument>("aaf_open", { documentId: event.payload });
        if (!disposed && before && current.current === before) {
          const next = { ...saved, manifest: { ...before.manifest, graph: saved.manifest.graph, recording_dates: saved.manifest.recording_dates } };
          current.current = next; setDocument(next);
        }
      } catch (cause) { if (!disposed) setError(formatError(cause)); }
    };
    const subscription = listen<string>("saucebunny:multitrack-changed", onSaucebunnyMultitrackChanged);
    void subscription.catch(cause => { if (!disposed) setError(formatError(cause)); });
    return () => { disposed = true; void subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, [documentId]);
  const tracks = document?.manifest.tracks;
  const mediaKey = document ? mediaRevision(document) : "";
  const requested = visible.join("|");
  const waveformCache = useRef<Record<string, number[][]>>({});
  useEffect(() => { waveformCache.current = {}; setWaveforms({}); setWaveformErrors({}); }, [documentId, mediaKey]);
  useEffect(() => {
    if (!active || loading || !documentId || !tracks) return;
    let cancelled = false;
    let jobId: string | null = null;
    void (async () => {
      for (const track of tracks) {
        if (cancelled) break;
        const snapshot = current.current;
        if (!snapshot || !laneReady(snapshot, track.id) || (requested ? !requested.split("|").includes(track.id) : alternativeLane(snapshot, track.id))) continue;
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
  }, [active, loading, documentId, tracks, mediaKey, requested]);

  const rename = useCallback((trackId: string, ownerName: string, castMemberId?: string | null, color?: string | null, preferences?: Pick<AafTrackLabel, "gender" | "marker_color">) => {
    const before = current.current;
    if (!before) return;
    const existing = before.labels.find(label => label.track_id === trackId);
    const labels = [...before.labels.filter((label) => label.track_id !== trackId), { ...existing,
      ...(preferences?.gender !== undefined ? { gender: preferences.gender } : {}),
      ...(preferences?.marker_color !== undefined ? { marker_color: preferences.marker_color } : {}),
      track_id: trackId, owner_name: ownerName.trim().normalize("NFC"), cast_member_id: castMemberId === undefined ? existing?.cast_member_id ?? null : castMemberId, color: color === undefined ? existing?.color ?? null : color }];
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
  return { document, saved, loading, error, labelStatus, waveforms, waveformErrors, load, cancelImport, rename, acceptTranscript, showTracks,
    sequenceChoices, chooseSequence: (id: string) => { if (sequenceChoices) void load(undefined, sequenceChoices.path, id); }, cancelChoice: () => setSequenceChoices(null) };
}
