import { applyOrderToSlots } from "../lib/reorder";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppStatus, ClientLog, ExportOpts, Metadata, QueueSource, QueuedClip, RecentClip,
} from "../types";
import type { ToastKind } from "../components/CanvasToast";
import { formatError } from "../lib/error-format";
import { framesToTc, secondsToTc } from "../lib/timecode";
import { sanitizeFilename } from "../lib/filename";
import { newJobId } from "../lib/job-id";
import { pushRecentClip } from "../lib/recent-clips";

/** Enumerated by tsc from the moved block, not written from memory. */
export type ClipQueueDeps = {
  metadata: Metadata | null;
  metadataRef: { current: Metadata | null };
  sourceKind: string;
  localFilePath: string | null;
  exportOpts: ExportOpts;
  fps: number;
  inFrames: number | null;
  outFrames: number | null;
  queueRunning: boolean;
  clipQueueRef: { current: QueuedClip[] };
  queueResolverRef: {
    current: ((r: { success: boolean; path?: string; error?: string }) => void) | null;
  };
  localExportCancelRef: { current: { cancelled: boolean } | null };
  /**
   * Stop, as a fact about the RUN rather than about one item.
   *
   * The runner used to infer "the user stopped" from the shape of the current
   * item's result, and that inference had two holes a real Stop falls straight
   * through. Between items nothing is in flight at all, so handleStop found
   * nothing to cancel and returned while the loop calmly started the next
   * export. And a local item stopped during its disk write still finishes
   * "ok", so the run continued from a result that was true about the file and
   * false about what the user wanted.
   *
   * A flag the loop reads at its own boundaries has neither hole: it is set
   * once, it outlives whatever was in flight when it was set, and every item
   * after it is simply never started.
   */
  queueStopRef: { current: boolean };
  runLocalClipExport: (args: {
    inputPath: string; startSeconds: number | null; endSeconds: number | null;
    format: "video-mp4" | "audio-mp3"; destPath: string; onProgress: (pct: number) => void;
  }) => Promise<
    | { kind: "ok"; bytesWritten: number; finalPath: string }
    | { kind: "cancelled" }
    | { kind: "unsupported"; reason: string }
    | { kind: "error"; message: string }
  >;
  appendLog: (tag: ClientLog["tag"], source: string, message: string) => void;
  pushNotification: (kind: ToastKind, title: string, body: string, path?: string) => void;
  cookiesBrowserOrNone: () => string | undefined;
  pushMarksUndo: (
    label: string,
    prevIn: number | null, prevOut: number | null,
    nextIn: number | null, nextOut: number | null,
  ) => void;
  setClipQueue: Dispatch<SetStateAction<QueuedClip[]>>;
  setQueueOpen: Dispatch<SetStateAction<boolean>>;
  setQueueRunning: Dispatch<SetStateAction<boolean>>;
  setStatus: Dispatch<SetStateAction<AppStatus>>;
  setProgress: Dispatch<SetStateAction<number>>;
  setJobId: Dispatch<SetStateAction<string | null>>;
  setRecents: Dispatch<SetStateAction<RecentClip[]>>;
  setInFrames: Dispatch<SetStateAction<number | null>>;
  setOutFrames: Dispatch<SetStateAction<number | null>>;
};

/**
 * The clip queue: add, remove, rename, bulk-rename, clear, and the sequential
 * runner that exports every queued item.
 *
 * Six handlers, 260 contiguous lines, lifted out of App.tsx verbatim — the
 * same technique as the keyboard dispatch and the single-clip export. The body
 * is unchanged so the diff is a move, and tsc enumerated the dependency
 * surface rather than a human guessing at it.
 *
 * The runner takes `runLocalClipExport` as a dependency rather than owning it:
 * that lives in useClipExport and is shared with the single Export button,
 * which is exactly why a running single export makes the queue wait. Those two
 * are one cancel-token owner and two callers, and keeping the ownership in one
 * place is what stops a second writer starting.
 */
export function useClipQueue(p: ClipQueueDeps) {
  const {
    metadata, metadataRef, sourceKind, localFilePath, exportOpts, fps,
    inFrames, outFrames, queueRunning, clipQueueRef, queueResolverRef,
    localExportCancelRef, queueStopRef, runLocalClipExport, appendLog, pushNotification,
    cookiesBrowserOrNone, pushMarksUndo,
    setClipQueue, setQueueOpen, setQueueRunning, setStatus, setProgress,
    setJobId, setRecents, setInFrames, setOutFrames,
  } = p;

  /** Add the current active selection as a new queued item, then clear marks.
   *  The item captures its SOURCE (web URL or local path), fps, and title at
   *  add time, so the queue survives source switches and mixed queues export
   *  each clip from the right place. */
  const handleAddToQueue = useCallback((range?: { inFrames: number; outFrames: number }) => {
    if (sourceKind === "file" && !localFilePath) {
      pushNotification("error", "Local file missing", "Re-import the file and try again.");
      return;
    }
    if (sourceKind !== "file" && !metadata?.webpage_url) {
      pushNotification("info", "Load a source first",
        "Fetch a URL or import a file, then mark the section you want to queue.");
      return;
    }
    // An explicit range wins over the closure's. A caller that just set the
    // marks in this same tick (the transcript selection's "Add to queue")
    // cannot see them here yet, so it hands them over instead.
    //
    // TYPE-CHECKED, not just truthy. This callback is handed straight to
    // onClick in several places (`onAddToQueue={handleAddToQueue}`), so React
    // calls it with a MouseEvent as the first argument - which is truthy, has
    // no inFrames, and therefore made the Add to queue BUTTON claim no marks
    // were set. Caught by e2e/smoke.spec.ts:669 within a minute of being
    // written; a positional first parameter on a callback that also serves as
    // an event handler has to defend itself.
    const explicit = range && typeof range.inFrames === "number" && typeof range.outFrames === "number"
      ? range : null;
    const inF = explicit ? explicit.inFrames : inFrames;
    const outF = explicit ? explicit.outFrames : outFrames;
    if (inF == null || outF == null) {
      pushNotification("info", "Set Mark in and Mark out first",
        "Mark the section with I and O.");
      return;
    }
    if (outF <= inF) {
      pushNotification("error", "Invalid range", "Mark out must be after Mark in.");
      return;
    }
    const baseName = sanitizeFilename(exportOpts.filename || "clip");
    // Bump until unique WITHIN the queue — a bare length+1 collides after a
    // remove-then-add (clip-1, clip-2; remove clip-1; add → length+1 = 2 →
    // another clip-2) and Export All would silently overwrite the first file.
    const nameFor = (n: number) => baseName === "clip" ? `clip-${n}` : `${baseName}-${n}`;
    let nextIndex = clipQueueRef.current.length + 1;
    while (clipQueueRef.current.some((c) => c.filename === nameFor(nextIndex))) nextIndex++;
    const source: QueueSource = sourceKind === "file"
      ? { kind: "file", path: localFilePath! }
      : { kind: "web", url: metadata!.webpage_url };
    const item: QueuedClip = {
      id: Math.random().toString(36).slice(2),
      source,
      fps,
      title: metadata?.title ?? nameFor(nextIndex),
      thumbnail: metadata?.thumbnail ?? null,
      inFrames: inF,
      outFrames: outF,
      filename: nameFor(nextIndex),
      format: exportOpts.format,
      // reencode/captions are yt-dlp features — meaningless for the
      // mediabunny local path, so file items pin them off.
      reencode: sourceKind === "file" ? false : exportOpts.reencode,
      captions: sourceKind === "file" ? false : exportOpts.captions,
      status: "queued",
    };
    setClipQueue((prev) => [...prev, item]);
    // Queueing consumes the selection — record the clear so ⌘Z restores the
    // marks (the queued item itself stays put; queue ops aren't undoable).
    pushMarksUndo("clear in/out", inF, outF, null, null);
    setInFrames(null);
    setOutFrames(null);
    setQueueOpen(true);
    appendLog("info", "queue", `Queued ${item.filename} (${framesToTc(item.inFrames, fps)} → ${framesToTc(item.outFrames, fps)})`);
  }, [sourceKind, localFilePath, metadata, inFrames, outFrames, fps, exportOpts.filename, exportOpts.format, exportOpts.reencode, exportOpts.captions, appendLog, pushNotification, pushMarksUndo, clipQueueRef, setClipQueue, setInFrames, setOutFrames, setQueueOpen]);

  /**
   * Put the QUEUED clips in a given order.
   *
   * Order is load-bearing here and was unchangeable by any means: the export
   * walks the queued items in array order one at a time, "Rename all" numbers
   * them base-1..N in that same order, and the row paints its position on
   * screen. Three promises about an order with nothing to set it.
   *
   * Only waiting clips move. A running one is mid-subprocess and a finished
   * one is a receipt, so applyOrderToSlots permutes just the slots the
   * waiting clips already occupy and leaves every other row where it is.
   *
   * Refused while the queue is running: handleExportQueue snapshots the
   * eligible list ONCE before its loop, so a reorder mid-run would rearrange
   * what is on screen without changing what is actually about to happen.
   */
  const handleQueueReorder = useCallback((orderedIds: readonly string[]) => {
    if (queueRunning) return;
    setClipQueue((prev) => applyOrderToSlots(
      prev, (c) => c.status === "queued", (c) => c.id, orderedIds,
    ));
  }, [queueRunning, setClipQueue]);

  const handleQueueRemove = useCallback((id: string) => {
    setClipQueue((prev) => prev.filter((c) => c.id !== id));
  }, [setClipQueue]);

  /**
   * Put a failed row back in the queue.
   *
   * A failed item's only control used to be the trash, and `handleExportQueue`
   * filters eligibility to `status === "queued"`, so pressing Export again
   * skipped it forever — while `saveClipQueue` persists only queued rows, so
   * quitting dropped it silently too. A row IS a range somebody marked by
   * hand, which this file's own persistence test calls the one thing in the
   * workspace that cannot be recreated by pressing a button again. Deleting it
   * meant re-finding the moment and re-marking in and out.
   *
   * Everything the runner needs is still on the item — source, fps, in/out,
   * filename, format, reencode, captions — so this only has to clear the
   * failure.
   */
  const handleQueueRetry = useCallback((id: string) => {
    setClipQueue((prev) => prev.map((c) => (
      c.id === id && c.status === "error"
        ? { ...c, status: "queued" as const, error: undefined, path: undefined }
        : c
    )));
  }, [setClipQueue]);

  /** Rename one queued clip (double-click in the drawer). Sanitizes; empty →
   *  no-op; a collision with a sibling bumps a numeric suffix until unique so
   *  Export All can't overwrite one file with another. */
  const handleQueueRename = useCallback((id: string, name: string) => {
    const base = sanitizeFilename(name);
    if (!base) return;
    setClipQueue((prev) => {
      const taken = new Set(prev.filter((c) => c.id !== id).map((c) => c.filename));
      let next = base;
      let n = 2;
      while (taken.has(next)) next = `${base}-${n++}`;
      return prev.map((c) => c.id === id ? { ...c, filename: next } : c);
    });
  }, [setClipQueue]);

  /** Bulk rename: every QUEUED item becomes base-1..N in queue order.
   *  Running/done/error items keep their names — their files may already
   *  exist on disk under them. */
  const handleQueueRenameAll = useCallback((rawBase: string) => {
    const base = sanitizeFilename(rawBase);
    if (!base) return;
    setClipQueue((prev) => {
      let n = 1;
      return prev.map((c) => c.status === "queued" ? { ...c, filename: `${base}-${n++}` } : c);
    });
  }, [setClipQueue]);

  const handleQueueClearAll = useCallback(() => {
    // Confirmed, like every other destructive action in the app — clearing
    // recents, deleting cached files and removing a library root all ask. The
    // queue was the one that did not, and it is the one holding work that
    // cannot be recreated by pressing a button again: each row is a range
    // somebody marked by hand.
    // Asked OUTSIDE the updater. A setState updater has to be pure - React is
    // free to run it more than once, and StrictMode does so deliberately to
    // surface exactly this - so a confirm() in there put the dialog on screen
    // twice in dev and made the outcome depend on which invocation React kept.
    // clipQueueRef mirrors the state every render, so reading it here costs
    // nothing and is not a stale closure.
    const pending = clipQueueRef.current.filter((c) => c.status === "queued").length;
    if (pending > 0 && !confirm(
      `Clear ${pending} queued clip${pending === 1 ? "" : "s"}? `
      + "The marks you set for them are not saved anywhere else.",
    )) return;
    setClipQueue([]);
  }, [clipQueueRef, setClipQueue]);

  /**
   * Drop the rows that are FINISHED, leaving everything still owed.
   *
   * Clear all is the only broom today, and it is the wrong one for this: it
   * takes queued-but-not-yet-exported ranges with it (hence its confirm) and
   * is disabled while the queue runs. So a session that exported ten clips
   * left ten green bands on the timeline, clearable only one row at a time
   * or by also throwing away work still owed.
   *
   * No confirm, deliberately, and the difference matters: a done row is a
   * receipt for a file already on disk, so removing it destroys nothing,
   * while a queued row is a range somebody marked by hand and nothing else
   * remembers. Errors are kept - a failed row is the only record that it
   * failed, and Retry lives on it.
   */
  const handleQueueClearDone = useCallback(() => {
    setClipQueue((prev) => prev.filter((c) => c.status !== "done"));
  }, [setClipQueue]);

  /** Run every "queued" item sequentially — web items through create_clip
   *  (yt-dlp/ffmpeg, per-item cookie retry), local items through the shared
   *  mediabunny core. Each item carries its own source + fps, so the queue
   *  is independent of whatever is currently loaded. */
  const handleExportQueue = useCallback(async () => {
    if (!exportOpts.folder) return;
    if (queueRunning) return;
    // A single local export owns the shared cancel token — running the queue
    // concurrently would clobber it and strand the Stop button for both.
    if (localExportCancelRef.current) {
      pushNotification("info", "Export in progress", "Wait for the current export to finish.");
      return;
    }
    const eligible = clipQueueRef.current.filter((c) => c.status === "queued");
    if (eligible.length === 0) return;
    // A Stop from the PREVIOUS run must not stop this one before it starts.
    queueStopRef.current = false;
    setQueueRunning(true);
    setStatus("exporting");
    setProgress(0);
    let okCount = 0;
    let failCount = 0;
    let cancelled = false;
    for (const item of eligible) {
      // Stop, checked at the one place that covers every route into it.
      // Both branches below end by returning here with no await in between,
      // so a flag set at ANY point during an item is seen before the next one
      // is started - including the two moments that used to slip through: the
      // gap between items, and a local item's uninterruptible disk write.
      //
      // The item that was in flight keeps whatever actually happened. A file
      // that landed is honestly "done"; relabelling it cancelled would be a
      // lie about a file on disk.
      if (queueStopRef.current) break;
      // Bail out if user cleared the queue mid-run.
      if (!clipQueueRef.current.some((c) => c.id === item.id)) continue;
      setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "running" } : c));
      setProgress(0);
      const itemR = Math.max(1, Math.round(item.fps));
      appendLog("info", "queue", `Exporting ${item.filename} (${framesToTc(item.inFrames, item.fps)} → ${framesToTc(item.outFrames, item.fps)})…`);
      const pushQueueRecent = (path: string) => {
        const rc: RecentClip = {
          id: Math.random().toString(36).slice(2),
          title: item.title,
          path,
          dur: secondsToTc((item.outFrames - item.inFrames) / itemR, item.fps),
          when: Date.now(),
          thumbnail: item.thumbnail,
          source: item.source.kind === "file" ? item.source.path : item.source.url,
        };
        setRecents((prev) => pushRecentClip(prev, rc));
      };

      // ── Local item → in-browser mediabunny export ──────────────────
      if (item.source.kind === "file") {
        const isAudio = item.format === "audio";
        const destPath = `${exportOpts.folder}/${item.filename}.${isAudio ? "mp3" : "mp4"}`;
        const result = await runLocalClipExport({
          inputPath: item.source.path,
          startSeconds: item.inFrames / itemR,
          endSeconds: item.outFrames / itemR,
          format: isAudio ? "audio-mp3" : "video-mp4",
          destPath,
          onProgress: setProgress,
        });
        if (result.kind === "cancelled") {
          cancelled = true;
          setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "queued" } : c));
          break;
        }
        if (result.kind === "ok") {
          setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "done", path: result.finalPath, error: undefined } : c));
          appendLog("ok", "mediabunny", `Wrote ${(result.bytesWritten / 1_000_000).toFixed(1)} MB → ${result.finalPath}`);
          pushQueueRecent(result.finalPath);
          okCount++;
        } else {
          // "unsupported" and "error" both land here — there is no ffmpeg
          // fallback for local clips (mirrors the single-export behavior).
          const msg = result.kind === "unsupported" ? result.reason : result.message;
          setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "error", error: msg } : c));
          appendLog("err", "mediabunny", msg);
          failCount++;
        }
        continue;
      }

      // ── Web item → create_clip (yt-dlp/ffmpeg subprocess) ──────────
      const webUrl = item.source.url;
      // One clip attempt for a given cookie setting (fresh job id each time so
      // cancellation tracks the live attempt). Resolves via the queue done-event
      // resolver, or via the invoke's own rejection.
      const runClip = (cookies: string | undefined) =>
        new Promise<{ success: boolean; path?: string; error?: string }>((resolve) => {
          void (async () => {
            const jobId = newJobId();
            setJobId(jobId);
            queueResolverRef.current = resolve;
            invoke("create_clip", {
              args: {
                url: webUrl,
                start: framesToTc(item.inFrames, item.fps),
                end: framesToTc(item.outFrames, item.fps),
                fps: item.fps,
                output_dir: exportOpts.folder,
                filename: item.filename,
                job_id: jobId,
                format: item.format,
                reencode: item.reencode,
                captions: item.captions,
                cookies_browser: cookies,
              },
            }).catch((err) => {
              if (queueResolverRef.current) {
                queueResolverRef.current = null;
                resolve({ success: false, error: formatError(err) });
              }
            });
          })();
        });
      let result = await runClip(cookiesBrowserOrNone());
      // Public social posts (LinkedIn…) break with auth cookies — retry public.
      if (
        !result.success &&
        cookiesBrowserOrNone() &&
        !(result.error ?? "").toLowerCase().includes("cancel")
      ) {
        appendLog("info", "queue", "create_clip failed with sign-in cookies. Retrying without…");
        result = await runClip(undefined);
      }
      // startsWith, not ===: resetForNewSource settles the in-flight clip with
      // "Cancelled - a different source was loaded" so the reason survives to
      // the log, and an exact match sent that straight to the generic failure
      // branch. The row said "Failed" with an alert icon for something the app
      // itself had just done on purpose.
      if (result.error?.startsWith("Cancelled")) {
        cancelled = true;
        setClipQueue((prev) => prev.map((c) => c.id === item.id ? { ...c, status: "queued" } : c));
        break;
      }
      setClipQueue((prev) => prev.map((c) => c.id === item.id ? {
        ...c,
        status: result.success ? "done" : "error",
        path: result.path,
        error: result.error,
      } : c));
      if (result.success) {
        okCount++;
        if (result.path) pushQueueRecent(result.path);
      } else {
        failCount++;
      }
    }
    // The head check cannot fire for a Stop during the LAST item, because the
    // loop ends rather than coming round again. Without this the run would
    // announce "Queue complete" for a run the user stopped.
    if (queueStopRef.current) cancelled = true;
    setQueueRunning(false);
    // Restore status only if the queue still owns it — a source switch
    // mid-run (which cancels the current item) has already set "fetching"
    // and will complete its own loaded/error transition. And a stale queue
    // can export with no source loaded — don't fake "loaded" then.
    setStatus((prev) => prev === "exporting" ? (metadataRef.current ? "loaded" : "empty") : prev);
    setProgress(0);
    if (cancelled) {
      pushNotification("info", "Queue stopped", `${okCount} exported, ${failCount} failed, rest still queued.`);
    } else if (failCount === 0) {
      pushNotification("success", "Queue complete", `${okCount} ${okCount === 1 ? "clip" : "clips"} exported.`);
    } else {
      pushNotification("error", "Queue finished with errors", `${okCount} ok · ${failCount} failed.`);
    }
  }, [exportOpts.folder, queueRunning, runLocalClipExport, appendLog, pushNotification, cookiesBrowserOrNone, clipQueueRef, localExportCancelRef, queueStopRef, metadataRef, queueResolverRef, setClipQueue, setJobId, setProgress, setQueueRunning, setRecents, setStatus]);

  return {
    handleAddToQueue, handleQueueRemove, handleQueueRetry, handleQueueRename,
    handleQueueRenameAll, handleQueueClearAll, handleQueueClearDone, handleExportQueue,
    handleQueueReorder,
  };
}
