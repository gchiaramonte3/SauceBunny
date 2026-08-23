import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DoneEvent } from "../types";

/**
 * Wait for one backend job to actually finish.
 *
 * `transcribe_local_file` is FIRE-AND-FORGET: it validates its arguments,
 * `tokio::spawn`s the whole ffmpeg + whisper pipeline, and returns the job id
 * in milliseconds. Awaiting the invoke therefore tells you the work STARTED,
 * which is not what a caller looping over files wants to know - the batch
 * queue marked every file done the moment it began, and ran N whisper
 * processes at once, each loading its own copy of the model.
 *
 * Completion arrives as a `transcript-done` event carrying the job id.
 *
 * The listener is registered BEFORE the caller starts the work, and that
 * ordering is the whole point: Tauri events are dropped, not queued, for a
 * listener that is not yet attached, so a job that fails fast on a bad codec
 * can emit its `done` before a listener attached afterwards exists - and the
 * caller waits forever for an event that already happened. Same mount race the
 * panel bus documents.
 *
 * Usage:
 *   const done = await watchJob(id);   // listener is live from here
 *   await invoke("transcribe_local_file", …);
 *   await done.finished;               // resolves when the pipeline ends
 */
export type JobWatch = {
  /** Resolves on success, rejects with the backend's message on failure. */
  finished: Promise<void>;
  /** Detach without waiting. Safe to call twice. */
  stop: () => void;
};

export async function watchJob(jobId: string): Promise<JobWatch> {
  let settle: { ok: () => void; fail: (e: Error) => void } | null = null;
  const finished = new Promise<void>((ok, fail) => {
    settle = { ok, fail: (e) => fail(e) };
  });

  let un: UnlistenFn | null = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    un?.();
    un = null;
  };

  un = await listen<DoneEvent>("transcript-done", (e) => {
    if (e.payload.job_id !== jobId) return;
    stop();
    if (e.payload.success) settle?.ok();
    // Cancelling emits a done with success:false and "Cancelled", so a
    // cancelled job settles here too rather than hanging the caller.
    else settle?.fail(new Error(e.payload.error || "Transcription failed"));
  });
  // `stop()` during the await above would have found `un` null; honour it now.
  if (stopped) un();

  return { finished, stop };
}
