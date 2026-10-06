import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { newJobId } from "../lib/job-id";
import { formatError } from "../lib/error-format";
import { PARAKEET_MODELS, type ParakeetModelId } from "../lib/parakeet-models";

export type ParakeetReady = Record<ParakeetModelId, boolean>;
const NONE: ParakeetReady = { "parakeet-ultra": false, "parakeet-tdt-0.6b-v3": false };

/**
 * Which Parakeet models are on disk, and a download that can be stopped. The
 * job id is held in a ref before the download starts, so Cancel always has
 * something to cancel (the same rule `cancellable-download-contract` pins
 * for Settings): FluidAudio reports no progress while it transfers, so a
 * download with no way out looks exactly like a hang.
 */
export function useParakeetModels() {
  const [ready, setReady] = useState<ParakeetReady>(NONE);
  const [downloading, setDownloading] = useState<ParakeetModelId | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const jobRef = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Only the newest check may set state: a slow answer from an older one
  // (a focus event racing the first look) must not undo a newer result.
  const revision = useRef(0);
  const check = useCallback(async (): Promise<ParakeetReady> => {
    const mine = ++revision.current;
    const entries = await Promise.all(PARAKEET_MODELS.map(async (model) =>
      [model.id, await invoke<boolean>("parakeet_model_downloaded", { model: model.id }).catch(() => false)] as const));
    const next = Object.fromEntries(entries) as ParakeetReady;
    if (mounted.current && mine === revision.current) setReady(next);
    return next;
  }, []);
  const download = useCallback(async (model: ParakeetModelId) => {
    if (jobRef.current) return;
    const job = newJobId();
    jobRef.current = job;
    setDownloading(model); setDownloadError(null);
    try { await invoke("download_parakeet_model", { jobId: job, model }); }
    catch (cause) { if (mounted.current) setDownloadError(formatError(cause)); }
    finally {
      jobRef.current = null;
      if (mounted.current) setDownloading(null);
      await check();
    }
  }, [check]);
  const cancel = useCallback(() => {
    const job = jobRef.current;
    if (job) void invoke("cancel_job", { jobId: job }).catch(() => { /* already finished */ });
  }, []);
  return { ready, check, downloading, downloadError, download, cancel };
}
