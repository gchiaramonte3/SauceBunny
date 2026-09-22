import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafEngine } from "../bindings/AafEngine";
import type { AafProgress } from "../bindings/AafProgress";
import type { AafTrackTranscript } from "../bindings/AafTrackTranscript";
import type { WhisperModel } from "../bindings/WhisperModel";
import { newJobId } from "../lib/job-id";
import { formatError } from "../lib/error-format";
import { loadMultitrackTranscriptionOptions, saveMultitrackTranscriptionOptions, type MultitrackTranscriptionOptions } from "../lib/multitrack-transcription-options";

export type MultitrackRunReport = { requested: number; saved: number; review: number; empty: number; stopped: boolean; failures: Array<{ trackId: string; message: string }> };
export type MultitrackModelChoice = { engine: AafEngine; modelId: string } & Partial<MultitrackTranscriptionOptions>;

export function useMultitrackTranscription(document: AafDocument, onTranscript: (result: AafTrackTranscript) => void, active = true) {
  const [engine, setEngine] = useState<AafEngine>("parakeet");
  const [models, setModels] = useState<WhisperModel[]>([]);
  const [modelId, setModelId] = useState("medium.en");
  const [options, setOptionsState] = useState(loadMultitrackTranscriptionOptions);
  const setOptions = useCallback((next: MultitrackTranscriptionOptions) => {
    setOptionsState(next); saveMultitrackTranscriptionOptions(next);
  }, []);
  const [parakeetReady, setParakeetReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<MultitrackRunReport | null>(null);
  const [resolution, setResolution] = useState<"success" | "error" | null>(null);
  const run = useRef<{ cancelled: boolean; jobId: string | null; index: number; count: number } | null>(null);
  const mounted = useRef(true);
  const sourceId = useRef(document.id); sourceId.current = document.id;
  const initialModelCheck = useRef(true);
  const modelCheckRevision = useRef(0);
  const receive = useRef(onTranscript); receive.current = onTranscript;
  const checkModels = useCallback(async () => {
    const revision = ++modelCheckRevision.current;
    try {
      const [whisper, ready] = await Promise.all([invoke<WhisperModel[]>("list_whisper_models"), invoke<boolean>("parakeet_model_downloaded")]);
      if (!mounted.current || revision !== modelCheckRevision.current) return;
      setModels(whisper.filter((model) => model.downloaded)); setParakeetReady(ready);
      if (initialModelCheck.current) { initialModelCheck.current = false; if (!ready && whisper.some((model) => model.downloaded)) setEngine("whisper"); }
      setModelId((current) => whisper.some((model) => model.id === current && model.downloaded) ? current : whisper.find((model) => model.downloaded)?.id ?? "medium.en");
    } catch (cause) { if (mounted.current && revision === modelCheckRevision.current) setError(formatError(cause)); }
  }, []);
  const invalidateModelCheck = useCallback(() => { ++modelCheckRevision.current; }, []);
  useEffect(() => {
    if (!active) return;
    void checkModels(); window.addEventListener("focus", checkModels);
    return () => { invalidateModelCheck(); window.removeEventListener("focus", checkModels); };
  }, [active, checkModels, invalidateModelCheck]);
  useEffect(() => {
    mounted.current = true;
    setLoading(false); setProgress(null); setStatus(""); setReport(null); setResolution(null); setError(null);
    let valid = true;
    const unlisten = listen<AafProgress>("aaf-progress", ({ payload }) => {
      const current = run.current;
      if (!valid || sourceId.current !== document.id || !current || current.cancelled || current.jobId !== payload.job_id) return;
      const part = payload.total_frames > 0 && Number.isFinite(payload.total_frames) && Number.isFinite(payload.completed_frames)
        ? Math.max(0, Math.min(1, payload.completed_frames / payload.total_frames)) : 0;
      const completed = (current.index + part) / current.count * 100;
      // Each bounded audio chunk alternates preparation and recognition. Those
      // worker phases are not new runs: keep one label and a forward-only fill.
      setProgress((previous) => Math.max(previous ?? 0, completed));
    });
    return () => {
      valid = false; mounted.current = false;
      const current = run.current;
      run.current = null;
      if (current) { current.cancelled = true; if (current.jobId) void invoke("cancel_job", { jobId: current.jobId }).catch(() => {}); }
      void unlisten.then((dispose) => dispose()).catch(() => {});
    };
  }, [document.id]);
  const stop = useCallback(() => {
    const current = run.current;
    if (!current) return;
    current.cancelled = true;
    setStatus("Stopping…");
    if (current.jobId) void invoke("cancel_job", { jobId: current.jobId }).catch((cause) => { if (mounted.current && run.current === current) setError(formatError(cause)); });
  }, []);
  const start = useCallback(async (trackIds: string[], startFrame: number, durationFrames: number, choice?: MultitrackModelChoice) => {
    if (run.current || !trackIds.length) return;
    const selectedEngine = choice?.engine ?? engine, selectedModel = choice?.modelId ?? modelId;
    const fast = selectedEngine === "whisper" && (choice?.fast ?? options.fast);
    const speechOnly = selectedEngine === "whisper" && (choice?.speechOnly ?? options.speechOnly);
    if (choice && (selectedEngine === "parakeet" ? !parakeetReady : !models.some((model) => model.id === selectedModel))) { setError("The selected model is not installed."); return; }
    const current = { cancelled: false, jobId: newJobId() as string | null, index: 0, count: trackIds.length };
    run.current = current; setLoading(true); setResolution(null); setError(null); setProgress(0); setReport(null);
    const ownsRun = () => mounted.current && run.current === current && sourceId.current === document.id;
    const outcome: MultitrackRunReport = { requested: trackIds.length, saved: 0, review: 0, empty: 0, stopped: false, failures: [] };
    try {
      for (const [index, trackId] of trackIds.entries()) {
        if (current.cancelled || !ownsRun()) break;
        current.index = index; if (index) current.jobId = newJobId();
        setStatus(`Transcribing ${index + 1} of ${trackIds.length}`);
        const completed = index / trackIds.length * 100;
        setProgress((previous) => Math.max(previous ?? 0, completed));
        try {
          const result = await invoke<AafTrackTranscript>("aaf_transcribe_track", { documentId: document.id, trackId, startFrame, durationFrames, engine: selectedEngine, modelId: selectedEngine === "parakeet" ? "parakeet-tdt-0.6b-v3" : selectedModel, language: "en", fast, speechOnly, jobId: current.jobId });
          // Native success is a committed result, even when Stop arrived while
          // its IPC reply was in flight. Stop still prevents the next track.
          if (!ownsRun()) break;
          receive.current(result);
          ++outcome.saved;
          if (result.status === "review") ++outcome.review;
          if (result.status === "empty") ++outcome.empty;
        } catch (cause) {
          if (current.cancelled || !ownsRun()) break;
          outcome.failures.push({ trackId, message: formatError(cause) });
        }
      }
      if (ownsRun()) {
        setStatus(current.cancelled ? `Stopped. ${outcome.saved} tracks saved.` : outcome.failures.length ? `${outcome.saved} tracks saved · ${outcome.failures.length} failed. See Get Info.` : outcome.review ? `${outcome.saved} tracks saved · ${outcome.review} need timing review.` : "Selected range saved for every track");
        setResolution(current.cancelled || outcome.review ? null : outcome.failures.length ? "error" : "success");
      }
    } catch (cause) {
      if (ownsRun()) { setStatus(current.cancelled ? "Stopped. Completed tracks are saved." : "Transcription failed"); if (!current.cancelled) { setError(formatError(cause)); setResolution("error"); } }
    } finally {
      if (ownsRun()) { setReport({ ...outcome, stopped: current.cancelled }); setLoading(false); setProgress(null); }
      if (run.current === current) run.current = null;
    }
  }, [document.id, engine, modelId, parakeetReady, models, options]);
  const ready = engine === "parakeet" ? parakeetReady : models.some((model) => model.id === modelId);
  return { engine, setEngine, models, modelId, setModelId, options, setOptions, parakeetReady, ready, loading, progress, status, error, report, resolution, clearResolution: () => setResolution(null), start, stop };
}
