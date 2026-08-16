import { useEffect, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DoneEvent } from "../bindings/DoneEvent";
import type { LogEvent } from "../bindings/LogEvent";
import type { ProgressEvent } from "../bindings/ProgressEvent";
import type { AppStatus, ClientLog, RecentClip } from "../types";
import { asLogTag } from "../types";
import type { ToastKind } from "../components/CanvasToast";
import type { StatefulPhase } from "../lib/stateful-phase";
import { humanizeSpawnError } from "../lib/error-format";
import { secondsToTc, tcToSeconds } from "../lib/timecode";
import { pushRecentClip } from "../lib/recent-clips";

/**
 * The three Tauri listeners a clip export reports through.
 *
 * Lifted out of App.tsx whole; the body is byte-identical to what was there,
 * extracted programmatically rather than retyped so the move cannot drift.
 *
 * The branch worth knowing about is the FIRST one. When the queue runner is
 * driving, `queueResolverRef` holds its promise resolver, and `clip-done` is
 * handed straight to it and returns — no toast, no recents entry, no status
 * change. A single export and a queued export share one event, and the queue
 * owns its own bookkeeping. Getting that wrong does not fail loudly: it
 * double-reports every queued clip.
 *
 * Same reasoning as use-transcript-listeners.ts for why this one is liftable
 * at all — every input is a stable reference, so the effect cannot re-subscribe.
 */

export type UseClipExportListenersDeps = {
  appendLog: (tag: ClientLog["tag"], source: string, message: string) => void;
  notify: (title: string, body: string) => void;
  pushNotification: (kind: ToastKind, title: string, body: string, path?: string) => void;
  /** Sees the RAW error text before the humanizer rewrites it. */
  classifyExtractorRot: (raw: string) => void;

  setStatus: Dispatch<SetStateAction<AppStatus>>;
  setExportPhase: Dispatch<SetStateAction<StatefulPhase>>;
  setResultPath: Dispatch<SetStateAction<string | null>>;
  setProgress: Dispatch<SetStateAction<number>>;
  setErrorDetail: Dispatch<SetStateAction<string | null>>;
  setRecents: Dispatch<SetStateAction<RecentClip[]>>;

  jobIdRef: MutableRefObject<string | null>;
  fpsRef: MutableRefObject<number>;
  /** Title/thumbnail snapshot taken at export START — deliberately not
   *  metadataRef, which may point at a source the user switched to mid-run. */
  clipJobMetaRef: MutableRefObject<{
    title: string; thumbnail: RecentClip["thumbnail"]; source?: string;
    inTc: string; outTc: string;
  } | null>;
  /** Set while the queue runner is driving; see the note above. */
  queueResolverRef: MutableRefObject<((r: { success: boolean; path?: string; error?: string }) => void) | null>;
};

export function useClipExportListeners(d: UseClipExportListenersDeps): void {
  const {
    appendLog, notify, pushNotification, classifyExtractorRot,
    setStatus, setExportPhase, setResultPath, setProgress, setErrorDetail, setRecents,
    jobIdRef, fpsRef, clipJobMetaRef, queueResolverRef,
  } = d;

useEffect(() => {
  const unlistens: UnlistenFn[] = [];
  let mounted = true;
  (async () => {
    const onClipLog = (e: { payload: LogEvent }) => {
      if (!mounted || e.payload.job_id !== jobIdRef.current) return;
      const sourceHint =
        e.payload.line.startsWith("[ffmpeg]") || e.payload.line.startsWith("[Merger]") ? "ffmpeg" :
        e.payload.line.startsWith("[") ? "yt-dlp" :
        e.payload.stream === "stderr" ? "stderr" : "yt-dlp";
      appendLog(asLogTag(e.payload.tag), sourceHint, e.payload.line);
    };
    const a = await listen<LogEvent>("clip-log", onClipLog);
    const onClipProgress = (e: { payload: ProgressEvent }) => {
      if (!mounted || e.payload.job_id !== jobIdRef.current) return;
      setProgress(e.payload.percent);
    };
    const b = await listen<ProgressEvent>("clip-progress", onClipProgress);
    const onClipDone = (e: { payload: DoneEvent }) => {
      if (!mounted || e.payload.job_id !== jobIdRef.current) return;
      // If we're running the queue, route the event into the queue runner
      // and skip the single-export bookkeeping below.
      if (queueResolverRef.current) {
        const resolver = queueResolverRef.current;
        queueResolverRef.current = null;
        resolver({
          success: e.payload.success,
          path: e.payload.path ?? undefined,
          error: e.payload.error ?? undefined,
        });
        return;
      }
      if (e.payload.success && e.payload.path) {
        // Stay on "loaded" so the canvas video stays visible; the toast +
        // notification bell announce completion non-blockingly.
        setStatus("loaded");
        setExportPhase("success"); // Export button → check flash
        setResultPath(e.payload.path);
        setProgress(0);
        const filename = e.payload.path.split("/").pop() ?? "Done.";
        pushNotification("success", "Clip exported", filename, e.payload.path);
        notify("Clip exported", filename);
        // Title/thumbnail snapshot from export start — NOT metadataRef, which
        // may now point at a different source the user switched to mid-export.
        const m = clipJobMetaRef.current;
        const f = fpsRef.current;
        if (m) {
          const span =
            (tcToSeconds(m.outTc, f) ?? 0) - (tcToSeconds(m.inTc, f) ?? 0);
          const dur = span > 0 ? secondsToTc(span, f) : "Full";
          const r: RecentClip = {
            id: Math.random().toString(36).slice(2),
            title: m.title,
            path: e.payload.path,
            dur,
            when: Date.now(),
            thumbnail: m.thumbnail,
            source: m.source,
          };
          setRecents((prev) => pushRecentClip(prev, r));
        }
      } else if (e.payload.error === "Cancelled") {
        setStatus("loaded");
        setExportPhase("idle"); // user cancel → straight to idle, no error flash
        setErrorDetail(null);
        setProgress(0);
        appendLog("warn", "ffmpeg", "Export cancelled");
        pushNotification("info", "Export cancelled", "");
      } else {
        setStatus("error");
        setExportPhase("error"); // Export button → cross flash
        // Humanize AFTER classifyExtractorRot sees the raw text (the
        // humanizer only rewrites EACCES spawn failures, but keep the
        // ordering honest anyway).
        classifyExtractorRot(e.payload.error ?? "");
        const msg = humanizeSpawnError(e.payload.error ?? "Export failed");
        setErrorDetail(msg);
        notify("Export failed", msg);
        pushNotification("error", "Export failed", msg);
      }
    };
    const c = await listen<DoneEvent>("clip-done", onClipDone);
    unlistens.push(a, b, c);
    // A cleanup that fires DURING the awaits above finds an empty array
    // and unregisters nothing — under StrictMode that leaked every
    // listener on each dev boot. The handlers are inert either way (each
    // starts with a `mounted` check) but stayed registered forever.
    if (!mounted) {
      unlistens.forEach((u) => u());
      unlistens.length = 0;
    }
  })();
  return () => {
    mounted = false;
    unlistens.forEach((u) => u());
  };
  // Every dep here is stable (empty deps of its own), so this runs once
  // for the app's lifetime and never re-subscribes.
  // Every entry is a stable reference — memoised callbacks, setState
  // functions, and refs — so this subscribes once and never re-subscribes,
  // which is what the comment above asserts and this array now enforces.
}, [
  appendLog, notify, pushNotification, classifyExtractorRot,
  setStatus, setExportPhase, setResultPath, setProgress, setErrorDetail, setRecents,
  jobIdRef, fpsRef, clipJobMetaRef, queueResolverRef,
]);
}
