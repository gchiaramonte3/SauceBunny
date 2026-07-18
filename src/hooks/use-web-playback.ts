// useWebPlayback — owns the web-source playback state machine + its I/O.
//
// This is the single home for the stream → resolve → download-fallback →
// watchdog → cache lifecycle that used to be smeared across handleFetch,
// runWebPreviewDownload, the onMediaError handler, and resetForNewSource in
// App.tsx (~300 lines of boolean/ref soup). The pure transitions live in
// `lib/web-playback-machine.ts`; this hook runs the Tauri side and dispatches
// results back into the reducer (which drops any stale-seq result — the one
// guard that replaces the old sourceSeqRef/webPreviewSeqRef checks).
//
// Constitution note: vanilla React (`useReducer`) — no state library. One
// focused hook, justified the same way as `use-panel-bus.ts`: extracting a
// cohesive state machine out of the God-component for readability.

import { useCallback, useEffect, useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildProxyUrl } from "../lib/stream-proxy";
import { formatError } from "../lib/error-format";
import { asLogTag, type LogTag } from "../types";
import type { ProgressEvent } from "../bindings/ProgressEvent";
import type { DoneEvent } from "../bindings/DoneEvent";
import type { LogEvent } from "../bindings/LogEvent";
import type { CachedStream } from "../bindings/CachedStream";
import {
  webPlaybackReducer,
  INITIAL_WEB_PLAYBACK,
  type WebPlaybackState,
  type StreamInfo,
} from "../lib/web-playback-machine";

/** What yt-dlp's resolver returns (mirrors DirectStreamResult). */
type DirectStream = {
  url: string;
  audio_url: string | null;
  width: number | null;
  height: number | null;
  vcodec: string | null;
  acodec: string | null;
};

type ToastKind = "success" | "error" | "info";

type Helpers = {
  appendLog: (tag: LogTag, channel: string, line: string) => void;
  pushNotification: (kind: ToastKind, title: string, body: string) => void;
  maybePromptYtAuth: (message: string, seq: number) => void;
  /** Browser to borrow cookies from, or undefined for none. */
  cookiesBrowser: () => string | undefined;
  /** Preview height cap (governs both the streamed res and the download). */
  previewMaxHeight: number;
  /** Playhead at dispatch time — carried on MEDIA_ERROR/WATCHDOG so the
   *  download fallback can resume where the stream died (RC4). */
  getPlayheadSeconds: () => number;
};

export type WebPlayback = {
  state: WebPlaybackState;
  // ── Read-model: matches the prop values App used to compute by hand, so
  //    Monitor and the players need no API change. ──
  streamUrl: string | null;
  audioUrl: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  cachePath: string | null;
  /** Playhead the stream died at (RC4) — the cached player resumes here. */
  cachedResumeAt: number;
  /** Where a freshly-retried stream should START (0 for a first play). */
  streamStartAt: number;
  downloading: boolean;
  downloadProgress: number;
  downloadJobId: string | null;
  // ── Actions (stable identities) ──
  /** `warmStream` (r112): a still-valid cached resolve from get_warm_start.
   *  Stream-first loads skip yt-dlp and hand it straight to the proxy/MSE
   *  path; if it then fails, the machine retries with ONE fresh resolve. */
  loadWeb: (url: string, mode: "stream-first" | "download-first", seq: number, warmStream?: CachedStream | null) => void;
  /** Warm boot from a COMPLETE downloaded copy: skip resolve/proxy entirely
   *  and play the file (LocalMediaPlayer) immediately. */
  loadCached: (url: string, cachePath: string, seq: number) => void;
  onPlayerReady: () => void;
  /** One-shot the RC4 resume after the ready-seek applied it. */
  consumeResume: () => void;
  /** Returns true if the error was handled (→ download fallback); false if the
   *  caller should fall through to its generic error handling. */
  onMediaError: (message: string) => boolean;
  reset: () => void;
  stop: () => void;
};

const WATCHDOG_MS = 15000;

export function useWebPlayback(helpers: Helpers): WebPlayback {
  const [state, dispatch] = useReducer(webPlaybackReducer, INITIAL_WEB_PLAYBACK);

  // Latest-value mirrors so async effects/callbacks never read stale props.
  const helpersRef = useRef(helpers);
  helpersRef.current = helpers;
  const stateRef = useRef(state);
  stateRef.current = state;

  const proxyBaseRef = useRef<string | null>(null);
  const proxyBaseFetchedRef = useRef(false);
  const downloadJobIdRef = useRef<string | null>(null);
  const attemptResolverRef = useRef<{ resolve: (p: string) => void; reject: (e: unknown) => void } | null>(null);
  // Warm-boot stream (r112): cached signed URLs handed in by loadWeb. The
  // resolve effect consumes this instead of calling yt-dlp — unless the
  // machine is in a `fresh: true` retry, which bypasses (and clears) it.
  const warmStreamRef = useRef<{ seq: number; stream: CachedStream } | null>(null);

  // Effect keys: only kind / seq / streaming-readiness re-trigger work — NOT
  // download progress (which keeps kind+seq stable, so the download isn't
  // restarted on every percent tick).
  const kind = state.kind;
  const seq = state.kind === "inactive" ? -1 : state.seq;
  const streamingReady = state.kind === "streaming" ? state.ready : false;

  // ── Persistent listeners for OUR download job. They filter on our own
  //    jobId ref, so they coexist with App's local-file playback-prep
  //    listeners (which filter on the local prep job id). ──
  useEffect(() => {
    let mounted = true;
    const unlistens: Array<() => void> = [];
    void (async () => {
      const p = await listen<ProgressEvent>("playback-prep-progress", (e) => {
        if (!mounted || e.payload.job_id !== downloadJobIdRef.current) return;
        const s = stateRef.current;
        if (s.kind === "downloading") dispatch({ t: "DOWNLOAD_PROGRESS", seq: s.seq, progress: e.payload.percent });
      });
      const d = await listen<DoneEvent>("playback-prep-done", (e) => {
        if (!mounted || e.payload.job_id !== downloadJobIdRef.current) return;
        const r = attemptResolverRef.current;
        attemptResolverRef.current = null;
        if (e.payload.success && e.payload.path) r?.resolve(e.payload.path);
        else r?.reject(e.payload.error ?? "Download failed");
      });
      const g = await listen<LogEvent>("playback-prep-log", (e) => {
        if (!mounted || e.payload.job_id !== downloadJobIdRef.current) return;
        helpersRef.current.appendLog(asLogTag(e.payload.tag), "web-preview", e.payload.line);
      });
      unlistens.push(p, d, g);
    })();
    return () => { mounted = false; unlistens.forEach((u) => u()); };
  }, []);

  // ── Resolve effect: kicks off get_direct_stream_url on entering `resolving`.
  //    Warm boot (r112): when loadWeb carried still-valid cached URLs and this
  //    is NOT a fresh retry, skip yt-dlp entirely and stream from the cache. ──
  useEffect(() => {
    if (kind !== "resolving") return;
    const s = stateRef.current;
    if (s.kind !== "resolving") return;
    const mySeq = s.seq;
    const url = s.url;
    const fresh = s.fresh;
    let cancelled = false;
    void (async () => {
      const h = helpersRef.current;
      const warm = warmStreamRef.current;
      if (fresh) warmStreamRef.current = null; // a failed cached URL must not be replayed
      if (!fresh && warm && warm.seq === mySeq) {
        // Cached signed URLs, still inside their validity window: no
        // extraction. Same proxy/MSE path as a fresh resolve.
        if (!proxyBaseFetchedRef.current) {
          proxyBaseRef.current = await invoke<string | null>("get_stream_proxy_base").catch(() => null);
          proxyBaseFetchedRef.current = true;
        }
        if (cancelled) return;
        const info: StreamInfo = {
          url: buildProxyUrl(proxyBaseRef.current, warm.stream.video_url),
          audioUrl: warm.stream.audio_url ?? null,
          videoCodec: warm.stream.vcodec ?? null,
          audioCodec: warm.stream.acodec ?? null,
        };
        h.appendLog("ok", "cache", "Stream ready from cache");
        dispatch({ t: "RESOLVED", seq: mySeq, stream: info, fromCache: true });
        return;
      }
      try {
        const stream = await invoke<DirectStream>("get_direct_stream_url", {
          url,
          cookiesBrowser: h.cookiesBrowser(),
          maxHeight: h.previewMaxHeight,
        });
        if (!proxyBaseFetchedRef.current) {
          proxyBaseRef.current = await invoke<string | null>("get_stream_proxy_base").catch(() => null);
          proxyBaseFetchedRef.current = true;
        }
        if (cancelled) return;
        const info: StreamInfo = {
          url: buildProxyUrl(proxyBaseRef.current, stream.url),
          audioUrl: stream.audio_url ?? null,
          videoCodec: stream.vcodec ?? null,
          audioCodec: stream.acodec ?? null,
        };
        h.appendLog(
          "ok",
          "yt-dlp",
          `Direct stream ready · ${stream.width ?? "?"}×${stream.height ?? "?"} ${stream.vcodec ?? ""}${stream.audio_url ? " · split A/V merged" : ""} · via 127.0.0.1 proxy`.trim(),
        );
        dispatch({ t: "RESOLVED", seq: mySeq, stream: info, fromCache: false });
      } catch (err) {
        if (cancelled) return;
        const msg = formatError(err);
        h.appendLog("warn", "yt-dlp", `Direct stream failed: ${msg}. Falling back to download.`);
        h.maybePromptYtAuth(msg, mySeq);
        dispatch({ t: "RESOLVE_FAILED", seq: mySeq });
      }
    })();
    return () => { cancelled = true; };
  }, [kind, seq]);

  // ── Watchdog: if the MSE pipeline doesn't open within 15s, fall back. Re-runs
  //    when `ready` flips (which clears the timer). For a CACHED stream the
  //    fallback is a fresh resolve (the URL likely expired), not a download. ──
  useEffect(() => {
    if (kind !== "streaming" || streamingReady) return;
    const mySeq = seq;
    const t = window.setTimeout(() => {
      const h = helpersRef.current;
      const s = stateRef.current;
      if (s.kind === "streaming" && s.fromCache) {
        h.appendLog("info", "cache", "Cached stream didn't open in 15s. Getting a fresh URL.");
      } else {
        h.appendLog("warn", "media", "Stream didn't open in 15s. Falling back to download.");
        h.pushNotification("info", "Downloading preview…", "Fetching the file via yt-dlp so you can scrub and mark in-app.");
      }
      dispatch({ t: "WATCHDOG", seq: mySeq, atSeconds: helpersRef.current.getPlayheadSeconds() });
    }, WATCHDOG_MS);
    return () => window.clearTimeout(t);
  }, [kind, seq, streamingReady]);

  // ── Download effect: runs yt-dlp download_web_preview on entering
  //    `downloading`, with the cookies → no-cookies retry. ──
  useEffect(() => {
    if (kind !== "downloading") return;
    const s = stateRef.current;
    if (s.kind !== "downloading") return;
    const mySeq = s.seq;
    const url = s.url;
    let cancelled = false;
    void (async () => {
      const h = helpersRef.current;
      // One download attempt for a given cookie setting; resolves to the cache
      // path or rejects (via the playback-prep-done event / invoke rejection).
      const attempt = (cookies: string | undefined) =>
        new Promise<string>((resolve, reject) => {
          void (async () => {
            const jobId = await invoke<string>("new_job_id");
            downloadJobIdRef.current = jobId;
            dispatch({ t: "DOWNLOAD_STARTED", seq: mySeq, jobId });
            attemptResolverRef.current = { resolve, reject };
            invoke("download_web_preview", {
              args: { url, job_id: jobId, cookies_browser: cookies, max_height: h.previewMaxHeight },
            }).catch((err) => {
              if (attemptResolverRef.current) { attemptResolverRef.current = null; reject(err); }
            });
          })().catch(reject);
        });
      h.appendLog("info", "web-preview", "CDN rejected cross-origin fetch. Downloading via yt-dlp…");
      try {
        const cookies = h.cookiesBrowser();
        let cachePath: string;
        try {
          cachePath = await attempt(cookies);
        } catch (err) {
          const m = formatError(err);
          // Public social posts (LinkedIn…) break with auth cookies — retry public.
          if (cookies && !m.includes("Cancelled") && !m.includes("Source changed") && !cancelled) {
            h.appendLog("info", "web-preview", "Download failed with sign-in cookies. Retrying without…");
            cachePath = await attempt(undefined);
          } else {
            throw err;
          }
        }
        if (cancelled) return;
        h.appendLog("ok", "web-preview", `Cached preview ready → ${cachePath}`);
        dispatch({ t: "DOWNLOAD_DONE", seq: mySeq, cachePath });
      } catch (err) {
        if (cancelled) return;
        const msg = formatError(err);
        // Cancellation / source-switch are handled by stop()/reset(); stay quiet.
        if (msg.includes("Source changed") || msg.includes("Cancelled")) return;
        h.appendLog("err", "web-preview", `Preview download failed: ${msg}`);
        h.pushNotification("error", "Preview unavailable", msg);
        h.maybePromptYtAuth(msg, mySeq);
        dispatch({ t: "DOWNLOAD_FAILED", seq: mySeq, message: msg });
      } finally {
        downloadJobIdRef.current = null;
      }
    })();
    return () => { cancelled = true; };
  }, [kind, seq]);

  // ── Actions (stable) ──
  const cancelActiveJob = useCallback(() => {
    const id = downloadJobIdRef.current;
    downloadJobIdRef.current = null;
    // Reject (not just drop) the pending attempt so the download async unwinds
    // via its "Cancelled" catch instead of hanging on a promise that never
    // settles (the done-event listener filters on the now-null jobId ref).
    const resolver = attemptResolverRef.current;
    attemptResolverRef.current = null;
    if (resolver) resolver.reject(new Error("Cancelled"));
    if (id) void invoke("cancel_job", { jobId: id }).catch(() => { /* best-effort */ });
  }, []);

  const loadWeb = useCallback((url: string, mode: "stream-first" | "download-first", seqArg: number, warmStream?: CachedStream | null) => {
    warmStreamRef.current = mode === "stream-first" && warmStream
      ? { seq: seqArg, stream: warmStream }
      : null;
    dispatch({ t: "LOAD", seq: seqArg, url, mode });
  }, []);

  const loadCached = useCallback((url: string, cachePath: string, seqArg: number) => {
    warmStreamRef.current = null;
    dispatch({ t: "LOAD_CACHED", seq: seqArg, url, cachePath });
  }, []);

  const onPlayerReady = useCallback(() => {
    const s = stateRef.current;
    if (s.kind === "streaming") dispatch({ t: "PLAYER_READY", seq: s.seq });
  }, []);

  const onMediaError = useCallback((message: string): boolean => {
    const s = stateRef.current;
    if (s.kind === "streaming") {
      const h = helpersRef.current;
      if (s.fromCache) {
        // The cached signed URL rotted (403/expired). One fresh resolve
        // before the download fallback — no toast, this self-heals fast.
        h.appendLog("info", "cache", `Cached stream URL failed (${message}). Getting a fresh URL.`);
        dispatch({ t: "MEDIA_ERROR", seq: s.seq, atSeconds: helpersRef.current.getPlayheadSeconds() });
        return true;
      }
      // r81: not a failure from the user's POV — some sources (HLS-only /
      // live broadcasts) just can't decode in WKWebView's MSE pipeline, so
      // we quietly download a playable copy. Keep it `info`, not `warn`.
      h.appendLog("info", "media", `In-app stream unavailable for this source (${message}). Downloading a playable copy instead…`);
      h.pushNotification("info", "Downloading preview…", "Couldn't stream this source in-app. Fetching the file so you can scrub and mark.");
      dispatch({ t: "MEDIA_ERROR", seq: s.seq, atSeconds: helpersRef.current.getPlayheadSeconds() });
      return true;
    }
    return false;
  }, []);

  const reset = useCallback(() => {
    cancelActiveJob();
    warmStreamRef.current = null;
    dispatch({ t: "RESET" });
  }, [cancelActiveJob]);

  // Cancel an in-flight download fallback (Stop button). Self-gating: a no-op
  // unless we're actually downloading, so Stop during live streaming / cached
  // playback doesn't tear the player down.
  const stop = useCallback(() => {
    if (stateRef.current.kind !== "downloading") return;
    helpersRef.current.appendLog("warn", "web-preview", "Preview download cancelled");
    cancelActiveJob();
    dispatch({ t: "RESET" });
  }, [cancelActiveJob]);

  // Review fix: one-shot the RC4 resume — App calls this right after the
  // ready-seek so a later player remount can't re-apply a stale position.
  const consumeResume = useCallback(() => {
    const s = stateRef.current;
    if (s.kind === "cached") dispatch({ t: "RESUME_CONSUMED", seq: s.seq });
  }, []);

  return {
    state,
    streamUrl: state.kind === "streaming" ? state.stream.url : null,
    audioUrl: state.kind === "streaming" ? state.stream.audioUrl : null,
    videoCodec: state.kind === "streaming" ? state.stream.videoCodec : null,
    audioCodec: state.kind === "streaming" ? state.stream.audioCodec : null,
    cachePath: state.kind === "cached" ? state.cachePath : null,
    cachedResumeAt: state.kind === "cached" ? state.resumeAtSeconds : 0,
    /** Where a freshly-retried stream should START (0 for a first play). */
    streamStartAt: state.kind === "streaming" ? state.resumeAtSeconds : 0,
    downloading: state.kind === "downloading",
    downloadProgress: state.kind === "downloading" ? state.progress : 0,
    downloadJobId: state.kind === "downloading" ? state.jobId : null,
    loadWeb,
    loadCached,
    onPlayerReady,
    consumeResume,
    onMediaError,
    reset,
    stop,
  };
}
