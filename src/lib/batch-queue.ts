/**
 * A serial run over a set of files, and what happens when it goes wrong.
 *
 * SERIAL ON PURPOSE. Whisper saturates the machine on one file; firing
 * seventeen at once does not finish seventeen times sooner, it thrashes and
 * makes the app unusable while it does. The queue exists to make "transcribe
 * these" a background thing the user can walk away from, which means one at a
 * time, in view order, with the option to stop.
 *
 * THE TWO RULES WORTH WRITING DOWN, because both are about failure:
 *
 *   1. ONE FILE FAILING DOES NOT STOP THE BATCH. A corrupt file, a codec
 *      ffmpeg refuses, a full disk — the run continues and the failure is
 *      recorded against that file. A batch that aborts on the first bad item
 *      leaves the user to work out which of seventeen it was, and re-run the
 *      rest by hand.
 *   2. CANCELLING DOES NOT REWRITE HISTORY. Files already transcribed stay
 *      done; only what had not started becomes skipped. The one in flight is
 *      left alone here — the caller kills the job and reports its real
 *      outcome — because pretending it was skipped would claim a file was not
 *      touched when a partial .srt may already be on disk.
 */

export type BatchStatus = "pending" | "running" | "done" | "error" | "skipped";

export type BatchItem = {
  path: string;
  /** Display label; the queue never derives it, so callers keep control. */
  name: string;
  status: BatchStatus;
  /** Present only on "error". */
  error?: string;
};

export type BatchState = {
  items: readonly BatchItem[];
  /** True once the user has stopped it — no further work should be started. */
  cancelled: boolean;
};

export const EMPTY_BATCH: BatchState = { items: [], cancelled: false };

/** A fresh run. Order is the caller's — which should be display order. */
export function startBatch(files: readonly { path: string; name: string }[]): BatchState {
  return {
    items: files.map((f) => ({ path: f.path, name: f.name, status: "pending" as const })),
    cancelled: false,
  };
}

/** Index of the next file to run, or -1 when there is nothing left to start. */
export function nextPending(s: BatchState): number {
  if (s.cancelled) return -1;
  return s.items.findIndex((i) => i.status === "pending");
}

/** Set one item's status. Unknown index returns the state unchanged. */
export function markItem(
  s: BatchState, idx: number, status: BatchStatus, error?: string,
): BatchState {
  if (idx < 0 || idx >= s.items.length) return s;
  const items = s.items.map((it, i) => (
    i === idx ? { ...it, status, ...(error ? { error } : {}) } : it
  ));
  return { ...s, items };
}

/**
 * Stop the run.
 *
 * Everything not yet started becomes skipped; anything already done, failed or
 * IN FLIGHT keeps the status it earned. See rule 2 above — the running file may
 * already have written output, so calling it "skipped" would be a lie.
 */
export function cancelBatch(s: BatchState): BatchState {
  return {
    cancelled: true,
    items: s.items.map((it) => (it.status === "pending" ? { ...it, status: "skipped" as const } : it)),
  };
}

export type BatchProgress = {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  /** The file being worked on, for the status line. */
  running: BatchItem | null;
  /** Nothing running and nothing left to start. */
  finished: boolean;
  /** done + failed + skipped — what the progress bar fills to. */
  settled: number;
};

export function batchProgress(s: BatchState): BatchProgress {
  let done = 0, failed = 0, skipped = 0, pending = 0;
  let running: BatchItem | null = null;
  for (const it of s.items) {
    if (it.status === "done") done += 1;
    else if (it.status === "error") failed += 1;
    else if (it.status === "skipped") skipped += 1;
    else if (it.status === "pending") pending += 1;
    else if (it.status === "running") running = it;
  }
  return {
    total: s.items.length,
    done, failed, skipped, running,
    settled: done + failed + skipped,
    // An empty batch is not "finished" — it never started. Callers use this to
    // decide whether to show a result summary, and summarising a run that
    // never happened is noise.
    finished: s.items.length > 0 && running == null && pending === 0,
  };
}

/** One-line summary for the status strip, in plain words. */
export function batchSummary(p: BatchProgress): string {
  if (p.total === 0) return "";
  if (!p.finished && p.running) return `Transcribing ${p.running.name} · ${p.settled + 1} of ${p.total}`;
  const bits: string[] = [];
  if (p.done) bits.push(`${p.done} transcribed`);
  if (p.failed) bits.push(`${p.failed} failed`);
  if (p.skipped) bits.push(`${p.skipped} skipped`);
  return bits.join(" · ") || "Nothing to do";
}
