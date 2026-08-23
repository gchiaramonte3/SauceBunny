import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  batchProgress, cancelBatch, EMPTY_BATCH, markItem, nextPending, startBatch,
  type BatchState,
} from "../lib/batch-queue";
import { sanitizeFilename } from "../lib/filename";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { watchJob } from "../lib/await-job";

/**
 * Transcribe a set of files, one after another, without loading any of them
 * into the player.
 *
 * WHY IT DOES NOT REUSE THE SINGLE-FILE PATH. App's transcribe flow is built
 * around the source that is currently OPEN: it reads metadata, duration and
 * marks off player state, and it guards itself with a single-flight
 * `transcriptState`. Driving it seventeen times would mean loading seventeen
 * files into the player in turn and fighting that guard on every one. The Rust
 * command underneath, `transcribe_local_file`, already takes an arbitrary path
 * — so the batch talks to it directly and leaves the player alone. A user can
 * keep working while a folder transcribes behind them.
 *
 * ONE AT A TIME, and cancellable. See lib/batch-queue for why serial, and for
 * the two failure rules (a bad file does not stop the run; cancelling does not
 * relabel work that already happened).
 */

export type BatchTranscribeSettings = {
  /** Where the .srt goes. Resolved by the caller, same as the single path. */
  outDir: string;
  modelId: string;
  engine: string;
  language: string;
  detectSpeakers: boolean;
  /** 0 or less means "let the diarizer decide". */
  expectedSpeakers: number;
};

export function useBatchTranscribe(
  onLog?: (level: "info" | "err", msg: string) => void,
) {
  const [state, setState] = useState<BatchState>(EMPTY_BATCH);
  /** The in-flight Rust job, so cancel can actually kill the process rather
   *  than just stopping the queue from handing out more work. */
  const jobRef = useRef<string | null>(null);
  /** Mirrors `state` for the async loop, which cannot read through setState. */
  const stateRef = useRef<BatchState>(EMPTY_BATCH);
  const runningRef = useRef(false);

  const apply = useCallback((next: BatchState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const start = useCallback(async (
    files: readonly { path: string; name: string }[],
    settings: BatchTranscribeSettings,
  ) => {
    // A second press while a run is live must not start a parallel queue.
    if (runningRef.current || files.length === 0) return;
    runningRef.current = true;
    apply(startBatch(files));

    try {
      for (;;) {
        const idx = nextPending(stateRef.current);
        if (idx < 0) break;
        const item = stateRef.current.items[idx];
        apply(markItem(stateRef.current, idx, "running"));

        try {
          const jobId = newJobId();
          jobRef.current = jobId;
          // Cancel can have landed during the PREVIOUS item's transcription -
          // this loop awaits one file per turn, so by the time it comes back
          // round the user may have pressed Stop minutes ago. Without this the
          // queue stopped handing out new work but the file already picked up
          // here still ran to the end. Checked after the id exists and before
          // the work starts. (The id itself is minted synchronously now, so it
          // opens no window of its own - see lib/job-id.)
          //
          // "skipped" rather than "error": nothing ran, so nothing failed and
          // no output was written. That is the case cancelBatch's comment
          // deliberately does not cover, since it is reasoning about a file
          // already in flight.
          if (stateRef.current.cancelled) {
            apply(markItem(stateRef.current, idx, "skipped"));
            break;
          }
          // Registered BEFORE the work starts, because `transcribe_local_file`
          // is fire-and-forget: it spawns the pipeline and returns the job id
          // in milliseconds. Awaiting the invoke alone told us the job had
          // STARTED - so every file was marked done the moment it began, the
          // whole selection was reported finished in about fifty
          // milliseconds, and N whisper processes ran at once, each loading
          // its own copy of the model. This module's own header has always
          // said "ONE AT A TIME"; this is what makes that true.
          const done = await watchJob(jobId);
          await invoke<string>("transcribe_local_file", {
            args: {
              input_path: item.path,
              output_dir: settings.outDir,
              // Name the transcript after the FILE, not after the export form's
              // filename box — in a batch that box would put the same name on
              // every one and each would overwrite the last.
              filename: sanitizeFilename(item.name.replace(/\.[^.]+$/, "")) || "transcript",
              model_id: settings.modelId,
              job_id: jobId,
              detect_speakers: settings.detectSpeakers,
              expected_speakers: settings.expectedSpeakers > 0 ? settings.expectedSpeakers : null,
              engine: settings.engine,
              language: settings.language,
              duration_seconds: null,
            },
          });
          // The pipeline itself, not the spawn. Cancelling emits a failed
          // done, so Stop settles this rather than stranding the loop.
          try {
            await done.finished;
          } finally {
            done.stop();
          }
          apply(markItem(stateRef.current, idx, "done"));
          onLog?.("info", `Transcribed ${item.name}`);
        } catch (err) {
          // Recorded against this file, and the run continues. Losing the rest
          // of a folder to one bad codec is the outcome this prevents.
          const msg = formatError(err);
          apply(markItem(stateRef.current, idx, "error", msg));
          onLog?.("err", `${item.name}: ${msg}`);
        } finally {
          jobRef.current = null;
        }
      }
    } finally {
      runningRef.current = false;
    }
  }, [apply, onLog]);

  const cancel = useCallback(() => {
    apply(cancelBatch(stateRef.current));
    const job = jobRef.current;
    // Stop the queue AND the process. Without the second half, "cancel" would
    // leave the current file grinding for minutes with no way to stop it.
    if (job) invoke("cancel_job", { jobId: job }).catch(() => { /* already gone */ });
  }, [apply]);

  const clear = useCallback(() => apply(EMPTY_BATCH), [apply]);

  return { state, progress: batchProgress(state), start, cancel, clear, busy: runningRef.current };
}
