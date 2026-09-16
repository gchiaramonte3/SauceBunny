import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { VideoRequest } from "../bindings/VideoRequest";
import type { VideoResponse } from "../bindings/VideoResponse";
import type { VideoProgress } from "../bindings/VideoProgress";
import { newJobId } from "../lib/job-id";
import { formatError, isAppError } from "../lib/error-format";

type Job = { id: string; stopped: boolean; started: boolean };
export function useVideoIntelligence() {
  const active = useRef<Job | null>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<VideoProgress | null>(null);
  const [error, setError] = useState("");
  const stop = useCallback(() => {
    const job = active.current;
    if (!job) return;
    job.stopped = true;
    if (job.started) void invoke("cancel_job", { jobId: job.id }).catch((cause) => {
      if (mounted.current && active.current === job) setError(formatError(cause));
    });
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
  }, [stop]);
  const run = useCallback(async (request: VideoRequest, preserveError = false): Promise<VideoResponse | null> => {
    if (active.current || !mounted.current) return null;
    const job: Job = { id: newJobId(), stopped: false, started: false };
    active.current = job;
    setBusy(true); if (!preserveError) setError(""); setProgress(null);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<VideoProgress>("video-intelligence-progress", ({ payload }) => {
        if (mounted.current && active.current === job && !job.stopped && payload.job_id === job.id) setProgress(payload);
      });
      if (job.stopped || !mounted.current) return null;
      job.started = true;
      const result = await invoke<VideoResponse>("video_intelligence_run", { jobId: job.id, request });
      return mounted.current && !job.stopped ? result : null;
    } catch (cause) {
      if (mounted.current && !job.stopped && !(isAppError(cause) && cause.kind === "Cancelled")) setError(formatError(cause));
      return null;
    } finally {
      unlisten?.();
      if (active.current === job) {
        active.current = null;
        if (mounted.current) { setBusy(false); setProgress(null); }
      }
    }
  }, []);
  return { run, stop, busy, progress, error };
}

/** One player's Stop must not clear another player's priority. */
const foregroundOwners = new Set<symbol>();
export function useVideoForegroundPriority(busy: boolean) {
  const owner = useRef(Symbol("video-priority"));
  useEffect(() => {
    const id = owner.current;
    if (busy) foregroundOwners.add(id); else foregroundOwners.delete(id);
    void invoke("video_set_foreground_busy", { busy: foregroundOwners.size > 0 }).catch(() => { /* Older apps have no worker to yield. */ });
    return () => {
      foregroundOwners.delete(id);
      void invoke("video_set_foreground_busy", { busy: foregroundOwners.size > 0 }).catch(() => { /* The application may be closing. */ });
    };
  }, [busy]);
}
