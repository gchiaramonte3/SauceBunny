import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DoneEvent } from "../bindings/DoneEvent";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";

/**
 * Pre-warming the FluidAudio speaker models (Settings ▸ Transcription).
 *
 * Lifted out of App.tsx whole: the state, the job-id tracking, both Tauri
 * listeners, and the two handlers. It was picked as the next extraction
 * because it is the one subsystem in that file that reaches outside itself
 * exactly twice — a notification, and the "models are cached now" latch — and
 * both are arguments rather than shared state. (Captions looks similar and is
 * not: its done-listener writes transcript state the Whisper pipeline owns.
 * See docs/ARCHITECTURE.md.)
 *
 * The job id is a REF, not state. In App it was both — a `useState` whose only
 * reader was the `useRef` mirroring it on every render — so starting a
 * download re-rendered the entire App tree to store a string that nothing
 * rendered. Nothing here needs it during render.
 */

export type DiarizerPrepareState = "idle" | "running" | "done" | "error";

export type UseDiarizerPrepareOptions = {
  /** Called once the models are cached, so the caller can latch its own flag. */
  onReady: () => void;
  /** Toast seam — same shape as App's pushNotification. */
  notify: (kind: "success" | "error" | "info", title: string, body: string) => void;
};

export type UseDiarizerPrepare = {
  state: DiarizerPrepareState;
  error: string | null;
  prepare: () => Promise<void>;
  cancel: () => Promise<void>;
};

export function useDiarizerPrepare({ onReady, notify }: UseDiarizerPrepareOptions): UseDiarizerPrepare {
  const [state, setState] = useState<DiarizerPrepareState>("idle");
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);

  // Latest-callback refs so the listener effect can run once, on mount, without
  // re-subscribing every time the caller re-renders with fresh closures.
  const onReadyRef = useRef(onReady);
  const notifyRef = useRef(notify);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { notifyRef.current = notify; }, [notify]);

  useEffect(() => {
    let mounted = true;
    const unlistens: Array<() => void> = [];
    (async () => {
      // Progress carries a per-phase line we do not surface yet; the channel is
      // still subscribed so the payload shape stays exercised for a future
      // indeterminate-bar pulse.
      const progress = await listen<{ job_id: string; line: string }>(
        "diarize-prepare-progress",
        () => {},
      );
      const done = await listen<DoneEvent>("diarize-prepare-done", (e) => {
        if (!mounted) return;
        // No job id yet means we never started this one — but a payload with a
        // DIFFERENT id is somebody else's run and must not resolve ours.
        if (jobIdRef.current && e.payload.job_id !== jobIdRef.current) return;
        if (e.payload.success) {
          setState("done");
          setError(null);
          onReadyRef.current();
          notifyRef.current(
            "success",
            "Speaker models ready",
            "FluidAudio cached. Future diarizations skip the download step.",
          );
        } else if (e.payload.error === "Cancelled") {
          // A cancel is not a failure: back to idle with nothing to report.
          setState("idle");
          setError(null);
        } else {
          setState("error");
          setError(e.payload.error ?? "Model preparation failed");
        }
      });
      if (!mounted) { progress(); done(); return; }
      unlistens.push(progress, done);
    })();
    return () => {
      mounted = false;
      unlistens.forEach((u) => u());
      unlistens.length = 0;
    };
  }, []);

  const prepare = useCallback(async () => {
    // Guarded on the ref rather than `state` so the callback keeps a stable
    // identity; a double-click must not start a second download.
    if (jobIdRef.current !== null) return;
    setState("running");
    setError(null);
    const id = newJobId();
    jobIdRef.current = id;
    try {
      await invoke<string>("prepare_diarizer_models", { jobId: id });
      // Resolution arrives on diarize-prepare-done.
    } catch (e) {
      jobIdRef.current = null;
      setState("error");
      setError(formatError(e));
    }
  }, []);

  const cancel = useCallback(async () => {
    const id = jobIdRef.current;
    if (!id) return;
    try { await invoke("cancel_job", { jobId: id }); } catch { /* already gone */ }
  }, []);

  // Clear the id once a run settles, so a later prepare() is allowed through.
  useEffect(() => {
    if (state !== "running") jobIdRef.current = null;
  }, [state]);

  return { state, error, prepare, cancel };
}
