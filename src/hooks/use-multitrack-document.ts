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
import type { AafProgress } from "../bindings/AafProgress";
import { alternativeLane, laneReady, mediaRevision } from "../lib/multitrack-graph";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { mergeTrackTranscript } from "../lib/multitrack";

export function useMultitrackDocument(active: boolean) {
  const [document, setDocument] = useState<AafDocument | null>(null);
  const [saved, setSaved] = useState<AafDocumentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolutionRequest, setResolutionRequest] = useState<{ id: string; token: number } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [mediaProgress, setMediaProgress] = useState<AafProgress | null>(null);
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
  const stopResolution = useCallback(() => { setResolutionRequest(null); setResolving(false); }, []);
  const load = useCallback(async (documentId?: string, selectedPath?: string, sequenceId?: string) => {
    if (importJob.current) return;
    const token = ++revision.current;
    setResolutionRequest(null); setResolving(false);
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
      if (token === revision.current && mounted.current) {
        current.current = next; setDocument(next); setLabelStatus("");
        if (next.manifest.graph?.sources.length) setResolutionRequest({ id: next.id, token });
      }
    } catch (cause) { if (token === revision.current && mounted.current) setError(formatError(cause)); }
    finally { if (token === revision.current && mounted.current) { importJob.current = null; setLoading(false); } }
  }, []);

  // Read only after queued owner writes. Never apply a resolver's old snapshot
  // over a newer label edit, transcript commit, or different open document.
  const reconcile = useCallback(async (id: string, token: number) => {
    for (;;) {
      const pending = saves.current.get(id);
      await pending;
      const before = current.current;
      if (!mounted.current || token !== revision.current || before?.id !== id) return;
      const saved = await invoke<AafDocument>("aaf_open", { documentId: id });
      if (!mounted.current || token !== revision.current || current.current?.id !== id) return;
      if (pending !== saves.current.get(id) || current.current !== before) continue;
      // Preserve track-array identity for graph-only checkpoints: other lanes
      // becoming available must not restart every visible waveform request.
      const tracks = JSON.stringify(saved.manifest.tracks) === JSON.stringify(before.manifest.tracks) ? before.manifest.tracks : saved.manifest.tracks;
      const next = { ...saved, manifest: { ...saved.manifest, tracks } };
      current.current = next; setDocument(next); return;
    }
  }, []);

  useEffect(() => {
    if (!active || !resolutionRequest) return;
    const { id, token } = resolutionRequest, jobId = newJobId();
    let disposed = false, finished = false;
    setResolving(true); setMediaProgress(null);
    const subscription = listen<AafProgress>("aaf-progress", ({ payload }) => {
      if (!disposed && payload.job_id === jobId) setMediaProgress(payload);
    });
    void (async () => {
      try {
        await subscription;
        if (disposed) return;
        await invoke<AafDocument>("aaf_resolve_media", { documentId: id, jobId });
      } catch (cause) {
        if (!disposed && mounted.current && token === revision.current) setError(formatError(cause));
      } finally {
        finished = true;
        // Stop still reveals the last atomically saved batch, even if its
        // event arrived during navigation or before listeners were attached.
        try { await reconcile(id, token); }
        catch (cause) { if (!disposed && mounted.current && token === revision.current) setError(formatError(cause)); }
        if (!disposed && mounted.current && token === revision.current) { setResolving(false); setResolutionRequest(null); }
      }
    })();
    return () => {
      disposed = true;
      if (!finished) void invoke("cancel_job", { jobId }).catch(() => {});
      void subscription.then(unlisten => unlisten()).catch(() => {});
    };
  }, [active, resolutionRequest, reconcile]);

  const documentId = document?.id;
  useEffect(() => {
    let disposed = false;
    const onSaucebunnyMultitrackChanged = async (event: { payload: string }) => {
      if (event.payload !== documentId) return;
      try {
        if (!disposed) await reconcile(event.payload, revision.current);
      } catch (cause) { if (!disposed) setError(formatError(cause)); }
    };
    const subscription = listen<string>("saucebunny:multitrack-changed", onSaucebunnyMultitrackChanged);
    void subscription.catch(cause => { if (!disposed) setError(formatError(cause)); });
    return () => { disposed = true; void subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, [documentId, reconcile]);
  const mediaKey = document ? JSON.stringify(document.manifest.tracks.map(track => mediaRevision(document, track.id))) : "";
  const requested = visible.join("|");
  const waveformCache = useRef<Record<string, number[][]>>({});
  const waveformKeys = useRef<Record<string, string>>({});
  useEffect(() => { waveformCache.current = {}; waveformKeys.current = {}; setWaveforms({}); setWaveformErrors({}); }, [documentId]);
  useEffect(() => {
    const snapshot = current.current;
    if (!snapshot) return;
    for (const id of Object.keys(waveformCache.current)) {
      if (waveformKeys.current[id] !== mediaRevision(snapshot, id)) {
        delete waveformCache.current[id]; delete waveformKeys.current[id];
        setWaveforms(prior => { const next = { ...prior }; delete next[id]; return next; });
        setWaveformErrors(prior => { const next = { ...prior }; delete next[id]; return next; });
      }
    }
  }, [mediaKey]);
  // One loader that outlives re-renders. A relink saves a checkpoint every few
  // seconds, and an overview build of an hour-long track on NEXIS takes longer
  // than that; if every checkpoint restarted the loop, no build would finish.
  // A build is cancelled only when ITS track's media changes or leaves view.
  const wanted = active && !loading && document ? document.manifest.tracks
    .filter(track => laneReady(document, track.id) && (requested ? visible.includes(track.id) : !alternativeLane(document, track.id)))
    .map(track => ({ documentId: document.id, id: track.id, key: mediaRevision(document, track.id) })) : [];
  const wantedKey = wanted.map(entry => entry.key).join("\n");
  const wantedRef = useRef(wanted); wantedRef.current = wanted;
  const loader = useRef<{ running: boolean; failed: Set<string> }>({ running: false, failed: new Set() });
  const waveformJob = useRef<string | null>(null), waveformJobKey = useRef<string | null>(null);
  const pumpWaveforms = useCallback(() => {
    const state = loader.current;
    if (state.running) return;
    state.running = true;
    const stillWanted = (key: string) => wantedRef.current.some(entry => entry.key === key);
    void (async () => {
      try {
        for (;;) {
          const next = wantedRef.current.find(entry => waveformKeys.current[entry.id] !== entry.key && !state.failed.has(entry.key));
          if (!next || !mounted.current) break;
          const jobId = newJobId(); waveformJob.current = jobId; waveformJobKey.current = next.key;
          try {
            const waveform = await invoke<AafWaveform>("aaf_waveform", { documentId: next.documentId, trackId: next.id, jobId });
            if (stillWanted(next.key)) {
              waveformCache.current[next.id] = waveform.peaks; waveformKeys.current[next.id] = next.key;
              setWaveforms(prior => ({ ...prior, [next.id]: waveform.peaks }));
            }
          } catch (cause) {
            if (stillWanted(next.key)) { state.failed.add(next.key); setWaveformErrors(prior => ({ ...prior, [next.id]: formatError(cause) })); }
          } finally { waveformJob.current = null; waveformJobKey.current = null; }
        }
      } finally {
        state.running = false;
        // A request that arrived after the last lookup must not be stranded.
        if (mounted.current && wantedRef.current.some(entry => waveformKeys.current[entry.id] !== entry.key && !state.failed.has(entry.key))) pumpWaveforms();
      }
    })();
  }, []);
  useEffect(() => {
    const jobId = waveformJob.current, key = waveformJobKey.current;
    if (jobId && !wantedRef.current.some(entry => entry.key === key)) void invoke("cancel_job", { jobId }).catch(() => {});
    pumpWaveforms();
  }, [wantedKey, pumpWaveforms]);
  useEffect(() => () => { const jobId = waveformJob.current; if (jobId) void invoke("cancel_job", { jobId }).catch(() => {}); }, []);

  const persistLabels = useCallback((documentId: string, labels: AafTrackLabel[]) => {
    setLabelStatus("Saving labels…");
    // Serialize writes so an older blur cannot overwrite a newer mic label.
    const save = (saves.current.get(documentId) ?? Promise.resolve()).then(async () => {
      try {
        await invoke<AafDocument>("aaf_save_labels", { documentId, labels });
        if (mounted.current && current.current?.id === documentId && saves.current.get(documentId) === save) setLabelStatus("Labels saved locally");
      } catch (cause) { if (mounted.current && current.current?.id === documentId) { setLabelStatus("Labels not saved"); setError(formatError(cause)); } }
    });
    saves.current.set(documentId, save);
  }, []);
  const rename = useCallback((trackId: string, ownerName: string, castMemberId?: string | null, color?: string | null, preferences?: Pick<AafTrackLabel, "gender" | "marker_color">) => {
    const before = current.current;
    if (!before) return;
    const existing = before.labels.find(label => label.track_id === trackId);
    const labels = [...before.labels.filter((label) => label.track_id !== trackId), { ...existing,
      ...(preferences?.gender !== undefined ? { gender: preferences.gender } : {}),
      ...(preferences?.marker_color !== undefined ? { marker_color: preferences.marker_color } : {}),
      track_id: trackId, owner_name: ownerName.trim().normalize("NFC"), cast_member_id: castMemberId === undefined ? existing?.cast_member_id ?? null : castMemberId, color: color === undefined ? existing?.color ?? null : color }];
    const next = { ...before, labels }; current.current = next; setDocument(next);
    persistLabels(before.id, labels);
  }, [persistLabels]);
  /** Resend the labels on screen after a failed save. */
  const retryLabels = useCallback(() => { const doc = current.current; if (doc) { setError(null); persistLabels(doc.id, doc.labels); } }, [persistLabels]);
  /** Forget a track's failed waveform build and ask for it again. */
  const retryWaveform = useCallback((trackId: string) => {
    const key = wantedRef.current.find(entry => entry.id === trackId)?.key;
    if (key) loader.current.failed.delete(key);
    setWaveformErrors(prior => { const next = { ...prior }; delete next[trackId]; return next; });
    pumpWaveforms();
  }, [pumpWaveforms]);
  const acceptTranscript = useCallback((transcript: AafTrackTranscript) => {
    const before = current.current;
    if (!before) return;
    const next = mergeTrackTranscript(before, transcript); current.current = next; setDocument(next);
  }, []);
  return { document, saved, loading, resolving, mediaProgress, stopResolution, error, labelStatus, waveforms, waveformErrors, load, cancelImport, rename, retryLabels, retryWaveform, acceptTranscript, showTracks,
    sequenceChoices, chooseSequence: (id: string) => { if (sequenceChoices) void load(undefined, sequenceChoices.path, id); }, cancelChoice: () => setSequenceChoices(null) };
}
