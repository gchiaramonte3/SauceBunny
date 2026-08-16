import { useCallback, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppStatus, ClientLog, ExportOpts, Metadata, RecentClip } from "../types";
import type { StatefulPhase } from "../lib/stateful-phase";
import type { ToastKind } from "../components/CanvasToast";
import { formatError } from "../lib/error-format";
import { framesToTc, secondsToTc } from "../lib/timecode";
import { sanitizeFilename } from "../lib/filename";
import { newJobId } from "../lib/job-id";
import { pushRecentClip } from "../lib/recent-clips";
import { exportLocalClipViaMediabunny } from "../lib/mediabunny-export";

/** Enumerated by tsc from the moved block, not written from memory. */
export type ClipExportDeps = {
  metadata: Metadata | null;
  metadataRef: { current: Metadata | null };
  sourceKind: string;
  localFilePath: string | null;
  exportOpts: ExportOpts;
  exportOptsRef: { current: ExportOpts };
  fps: number;
  inFrames: number | null;
  outFrames: number | null;
  sourceSeqRef: { current: number };
  localExportCancelRef: { current: { cancelled: boolean } | null };
  clipJobMetaRef: { current: {
    title: string; thumbnail: RecentClip["thumbnail"]; source?: string;
    inTc: string; outTc: string;
  } | null };
  appendLog: (tag: ClientLog["tag"], source: string, message: string) => void;
  notify: (title: string, body: string) => void;
  pushNotification: (kind: ToastKind, title: string, body: string, path?: string) => void;
  classifyExtractorRot: (msg: string) => void;
  cookiesBrowserOrNone: () => string | undefined;
  setStatus: Dispatch<SetStateAction<AppStatus>>;
  setProgress: Dispatch<SetStateAction<number>>;
  setResultPath: Dispatch<SetStateAction<string | null>>;
  setErrorDetail: Dispatch<SetStateAction<string | null>>;
  setExportPhase: Dispatch<SetStateAction<StatefulPhase>>;
  setJobId: Dispatch<SetStateAction<string | null>>;
  setRecents: Dispatch<SetStateAction<RecentClip[]>>;
};

/**
 * The single-clip export path: the shared local-clip core plus the Export
 * button's handler.
 *
 * Lifted out of App.tsx as one contiguous block, verbatim, the same way the
 * keyboard dispatch was — the body is unchanged so the diff is a move, and
 * tsc enumerated the dependency surface rather than a human guessing at it.
 *
 * `runLocalClipExport` is RETURNED, not kept private, because the queue runner
 * still lives in App.tsx and calls it. That is the pattern CLAUDE.md asks for:
 * destructure the result at the call site so no existing reference has to
 * change. It also owns the shared cancel token (`localExportCancelRef`), which
 * is why a running single export makes the queue button wait rather than
 * starting a second writer.
 */
export function useClipExport(p: ClipExportDeps) {
  const {
    metadata, metadataRef, sourceKind, localFilePath, exportOpts, exportOptsRef,
    fps, inFrames, outFrames, sourceSeqRef, localExportCancelRef, clipJobMetaRef,
    appendLog, notify, pushNotification, classifyExtractorRot, cookiesBrowserOrNone,
    setStatus, setProgress, setResultPath, setErrorDetail, setExportPhase,
    setJobId, setRecents,
  } = p;

  /**
   * Shared local-clip export core (single Export button + queued items):
   * mediabunny Conversion → bytes → write_bytes_to_path. Owns the cancel
   * token (Stop / source-switch flip it via localExportCancelRef); callers
   * keep their own status/notification/recents bookkeeping. There is no
   * ffmpeg fallback for local clips — "unsupported" surfaces as-is.
   */
  const runLocalClipExport = useCallback(async (args: {
    inputPath: string;
    startSeconds: number | null;
    endSeconds: number | null;
    format: "video-mp4" | "audio-mp3";
    destPath: string;
    /** 0..100 */
    onProgress: (pct: number) => void;
  }): Promise<
    | { kind: "ok"; bytesWritten: number; finalPath: string }
    | { kind: "cancelled" }
    | { kind: "unsupported"; reason: string }
    | { kind: "error"; message: string }
  > => {
    const cancelToken = { cancelled: false };
    localExportCancelRef.current = cancelToken;
    try {
      const result = await exportLocalClipViaMediabunny({
        inputPath: args.inputPath,
        startSeconds: args.startSeconds,
        endSeconds: args.endSeconds,
        format: args.format,
        onProgress: (p) => args.onProgress(p * 100),
      }, cancelToken);
      if (result.kind !== "ok") return result;
      // Persist via the RAW-BODY writer: the clip travels as the IPC body
      // itself. The old write_bytes_to_path route serialized the buffer as a
      // JSON number array — every byte decimal-printed into a string built
      // synchronously on the main thread. Measured at 100 MB: ~2s of frozen
      // UI and ~2.2 GB peak memory, repeated per queue item. The path rides
      // percent-encoded in a header (headers are Latin-1; titles aren't).
      // unique: destPath is derived (not saveDialog-vetted) — a collision
      // walks -2, -3 on disk exactly like create_clip, and NEVER fails
      // (review fix: this path used to hard-error on collision while the
      // web path uniquified, with the UI promising uniquing for both).
      const finalPath = await invoke<string>("write_raw_to_path", result.bytes, {
        headers: {
          "x-dest-path": encodeURIComponent(args.destPath),
          "x-unique": "1",
        },
      });
      return { kind: "ok", bytesWritten: result.bytes.byteLength, finalPath };
    } catch (err) {
      // formatError handles Error / AppError / string — `err instanceof Error`
      // alone misses the r51 discriminated-union shape.
      return { kind: "error", message: formatError(err) };
    } finally {
      // Ownership-checked release — a concurrently started export may have
      // installed ITS token; blindly nulling would strand its Stop button.
      if (localExportCancelRef.current === cancelToken) localExportCancelRef.current = null;
    }
  }, [, localExportCancelRef]);

  const handleExport = useCallback(async () => {
    if (!metadata || !exportOpts.folder) return;

    // ─── Local-file branch ──────────────────────────────────────────
    // Drive the clip via mediabunny's Conversion API (demux + stream-
    // copy or WebCodecs re-encode, no ffmpeg subprocess). MP3 rides
    // Mp3OutputFormat (the mp3-encoder extension registered in main.tsx);
    // everything else writes MP4 — Conversion handles passthrough vs.
    // re-encode internally based on codec compatibility.
    if (sourceKind === "file") {
      if (!localFilePath) {
        pushNotification("error", "Local file missing", "Re-import the file and try again.");
        return;
      }

      const r = Math.max(1, Math.round(fps));
      const startSec = inFrames  != null ? inFrames  / r : null;
      const endSec   = outFrames != null ? outFrames / r : null;
      const safe = sanitizeFilename(exportOpts.filename);
      if (!safe) {
        pushNotification("error", "Filename is empty", "Pick a filename before exporting.");
        return;
      }
      const isAudioOnly = exportOpts.format === "audio";
      const destPath = `${exportOpts.folder}/${safe}.${isAudioOnly ? "mp3" : "mp4"}`;

      setErrorDetail(null);
      setResultPath(null);
      setProgress(0);
      setStatus("exporting");
      setExportPhase("loading");
      appendLog("info", "mediabunny",
        `Exporting local clip ${startSec != null && endSec != null ? `${startSec.toFixed(2)}s → ${endSec.toFixed(2)}s` : "full"} → ${destPath}`);

      // Seq + metadata snapshot: a source switched mid-export must not have
      // its status clobbered or its title stamped on the old clip's Recents
      // entry (same discipline as the web path's clipJobMetaRef).
      const exportSeq = sourceSeqRef.current;
      const exportMeta = metadataRef.current;
      const result = await runLocalClipExport({
        inputPath: localFilePath,
        startSeconds: startSec,
        endSeconds: endSec,
        format: isAudioOnly ? "audio-mp3" : "video-mp4",
        destPath,
        onProgress: setProgress,
      });
      if (sourceSeqRef.current !== exportSeq) return;

      if (result.kind === "cancelled") {
        setStatus("loaded");
        setExportPhase("idle"); // user cancel → idle, no error flash
        setProgress(0);
        appendLog("warn", "mediabunny", "Local export cancelled.");
        pushNotification("info", "Export cancelled", "");
        return;
      }
      if (result.kind === "unsupported") {
        // Future: fall back to a Rust ffmpeg-based local-clip command.
        // For now surface clearly so the user knows what happened.
        appendLog("err", "mediabunny", `Unsupported for mediabunny export: ${result.reason}`);
        setStatus("error");
        setExportPhase("error");
        setErrorDetail(result.reason);
        pushNotification("error", "Local export not supported",
          "This file's codecs aren't compatible with the in-browser exporter yet. ffmpeg fallback for local clips is on the roadmap.");
        return;
      }
      if (result.kind === "error") {
        setErrorDetail(result.message);
        appendLog("err", "mediabunny", result.message);
        setStatus("error");
        setExportPhase("error");
        pushNotification("error", "Local export failed", result.message);
        return;
      }

      setStatus("loaded");
      setExportPhase("success"); // local clip written → check flash
      // finalPath is what unique-mode actually wrote (name-2.mp4 on a
      // collision) — every surface below must show THAT name.
      setResultPath(result.finalPath);
      setProgress(0);
      const filename = result.finalPath.split("/").pop() ?? "Done.";
      appendLog("ok", "mediabunny",
        `Wrote ${(result.bytesWritten / 1_000_000).toFixed(1)} MB → ${result.finalPath}`);
      pushNotification("success", "Clip exported", filename, result.finalPath);
      notify("Clip exported", filename);

      // Add to recents.
      const m = exportMeta;
      if (m) {
        const dur = (endSec != null && startSec != null)
          ? secondsToTc(endSec - startSec, fps)
          : (m.duration != null ? secondsToTc(m.duration, fps) : "Full");
        const rc: RecentClip = {
          id: Math.random().toString(36).slice(2),
          title: m.title,
          path: result.finalPath,
          dur,
          when: Date.now(),
          thumbnail: m.thumbnail,
          source: localFilePath ?? undefined,
        };
        setRecents((prev) => pushRecentClip(prev, rc));
      }
      return;
    }

    setErrorDetail(null);
    setResultPath(null);
    setProgress(0);
    setStatus("exporting");
    setExportPhase("loading"); // success/error flash arrives via the clip-done event
    const hasRange = inFrames != null && outFrames != null;
    const label = hasRange
      ? `${exportOpts.inTc} → ${exportOpts.outTc}`
      : "full clip";
    appendLog(
      "info",
      "ffmpeg",
      `Exporting ${label} · ${exportOpts.format}${hasRange && exportOpts.format !== "audio" ? (exportOpts.reencode ? " · re-encode" : " · lossless cut") : ""}`,
    );
    try {
      const id = newJobId();
      setJobId(id);
      // Attribute the Recent entry to THIS source now (see clipJobMetaRef) so a
      // source switch before clip-done can't stamp the new source's title on it.
      clipJobMetaRef.current = metadataRef.current
        ? {
            title: metadataRef.current.title,
            thumbnail: metadataRef.current.thumbnail,
            source: metadataRef.current.webpage_url ?? undefined,
            // Marks snapshot too: clearing/moving marks mid-export must not
            // relabel the finished clip's duration.
            inTc: exportOptsRef.current.inTc,
            outTc: exportOptsRef.current.outTc,
          }
        : null;
      // Marks may be null (full-clip export) — pass null through, the
      // backend skips --download-sections so yt-dlp just grabs the whole stream.
      const startStr = inFrames  != null ? framesToTc(inFrames,  fps) : null;
      const endStr   = outFrames != null ? framesToTc(outFrames, fps) : null;
      // create_clip is fire-and-forget (reports via the clip-done event), so a
      // frontend cookie-retry can't observe its failure — the backend owns the
      // cookie-fallback for the clip download (see spawn_video_clip).
      await invoke<string>("create_clip", {
        args: {
          url: metadata.webpage_url,
          start: startStr,
          end: endStr,
          fps,
          output_dir: exportOpts.folder,
          filename: sanitizeFilename(exportOpts.filename),
          job_id: id,
          format: exportOpts.format,
          reencode: exportOpts.reencode,
          captions: exportOpts.captions,
          cookies_browser: cookiesBrowserOrNone(),
        },
      });
    } catch (err) {
      // r51 / Vimeo-export bug: raw `String(err)` printed "[object Object]"
      // in both the canvas overlay AND the FFMPEG pipeline log because
      // the create_clip command now rejects with an AppError discriminated
      // union, not a string.
      const msg = formatError(err);
      setErrorDetail(msg);
      // Same rot check as the clip-done listener — create_clip can also
      // reject synchronously with yt-dlp's extractor error.
      classifyExtractorRot(msg);
      appendLog("err", "ffmpeg", msg);
      setStatus("error");
      setExportPhase("error"); // create_clip rejected synchronously → cross flash
    }
  }, [metadata, sourceKind, localFilePath, exportOpts, fps, inFrames, outFrames,
    runLocalClipExport, appendLog, pushNotification, classifyExtractorRot, notify,
    // Added when this moved out of App.tsx: inside the component the linter
    // could see these were refs and setState functions. Every one is
    // identity-stable (five useRef, seven useState setters, and
    // cookiesBrowserOrNone is now a useCallback with no deps), so the callback
    // identity is unchanged — the lint moved, the behaviour did not.
    clipJobMetaRef, cookiesBrowserOrNone, exportOptsRef, metadataRef, sourceSeqRef,
    setErrorDetail, setExportPhase, setJobId, setProgress, setRecents,
    setResultPath, setStatus]);

  return { runLocalClipExport, handleExport };
}
